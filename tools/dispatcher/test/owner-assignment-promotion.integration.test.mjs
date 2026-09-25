// MOV-359: deterministic proof that the promoter's real wiring
// (promoteEligible + createOwnerAssigner, exactly as cmdPromoteOnce in
// bin/dispatcher.mjs builds them) always writes the configured human owner
// to Linear -- and verifies the readback -- strictly before the Ready for
// Agent transition the handoff Loop (MOV-220) reacts to. That ordering is
// the whole point of the feature: Linear rejects a Loop delegate attempt on
// an issue with no assignee, so an assignee written *after* the state
// transition would still race the Loop and lose sometimes.
import { describe, it, expect } from "vitest";
import { promoteEligible, PROMOTION_COMMENT } from "../src/promoter.mjs";
import { createOwnerAssigner } from "../src/owner-assignment.mjs";

const TEAM_KEY = "MOV";
const OWNER_EMAIL = "adam@example.com";
const READY_SECTIONS = ["## Acceptance criteria", "- it works.", "", "### Testing Expectations", "- unit: covers it."].join("\n");

function backlogIssue(overrides = {}) {
  return {
    id: "id-1",
    identifier: "MOV-1",
    stateName: "Backlog",
    description: READY_SECTIONS,
    labels: [],
    blockedByIds: [],
    recentComments: [],
    assignee: null,
    ...overrides,
  };
}

/** A real-shaped fake LinearClient: every write is timestamped into one
 *  ordered log, exactly what a live audit of Linear activity would show. */
function fakeLinearClient({ member } = {}) {
  const log = [];
  return {
    log,
    async workspaceMemberByEmail(email) {
      log.push({ type: "workspaceMemberByEmail", email });
      return member;
    },
    async assignIssue(issueId, assigneeId) {
      log.push({ type: "assignIssue", issueId, assigneeId });
      return { success: true, assigneeId };
    },
    async moveToState(issueId, stateId) {
      log.push({ type: "moveToState", issueId, stateId });
    },
    async addComment(issueId, body) {
      log.push({ type: "addComment", issueId, body });
    },
  };
}

const ALL_SATISFIED = () => true;

describe("MOV-359: owner assignment lands before the Ready for Agent handoff", () => {
  it("assigns and verifies the owner, then promotes -- in that order, every time", async () => {
    const linearClient = fakeLinearClient({
      member: { id: "user-adam", name: "Adam Moore", active: true, isApp: false, teamKeys: [TEAM_KEY] },
    });
    const ownerAssignment = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });

    const results = await promoteEligible([backlogIssue()], {
      linearClient,
      readyForAgentStateId: "state-ready",
      isBlockerSatisfied: ALL_SATISFIED,
      ownerAssignment,
    });

    expect(results).toMatchObject([{ issue: "MOV-1", promoted: true, ownerAssigned: true }]);

    const types = linearClient.log.map((entry) => entry.type);
    expect(types).toEqual(["workspaceMemberByEmail", "assignIssue", "moveToState", "addComment"]);

    const assignAt = types.indexOf("assignIssue");
    const moveAt = types.indexOf("moveToState");
    expect(assignAt).toBeGreaterThanOrEqual(0);
    expect(assignAt).toBeLessThan(moveAt);

    // The Loop only watches for the *state* transition -- so the write it
    // will react to (moveToState) must never be reachable without the
    // assignee write (assignIssue) already having succeeded and verified.
    expect(linearClient.log[assignAt]).toMatchObject({ issueId: "id-1", assigneeId: "user-adam" });
    expect(linearClient.log[moveAt]).toMatchObject({ issueId: "id-1", stateId: "state-ready" });
    expect(linearClient.log.at(-1)).toMatchObject({ type: "addComment", issueId: "id-1", body: PROMOTION_COMMENT });
  });

  it("never assigns or promotes when the configured owner cannot be verified", async () => {
    const linearClient = fakeLinearClient({ member: null }); // lookup finds nobody
    const ownerAssignment = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });

    const results = await promoteEligible([backlogIssue()], {
      linearClient,
      readyForAgentStateId: "state-ready",
      isBlockerSatisfied: ALL_SATISFIED,
      ownerAssignment,
    });

    expect(results).toMatchObject([{ issue: "MOV-1", promoted: false, reason: expect.stringMatching(/^owner assignment: /) }]);
    expect(linearClient.log.map((entry) => entry.type)).toEqual(["workspaceMemberByEmail"]);
  });

  it("preserves an existing human assignee: no lookup, no write, straight to promotion", async () => {
    const linearClient = fakeLinearClient({
      member: { id: "user-adam", name: "Adam Moore", active: true, isApp: false, teamKeys: [TEAM_KEY] },
    });
    const ownerAssignment = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });

    const results = await promoteEligible(
      [backlogIssue({ assignee: { id: "user-existing", name: "Someone Else" } })],
      { linearClient, readyForAgentStateId: "state-ready", isBlockerSatisfied: ALL_SATISFIED, ownerAssignment },
    );

    expect(results).toMatchObject([{ issue: "MOV-1", promoted: true }]);
    expect(linearClient.log.map((entry) => entry.type)).toEqual(["moveToState", "addComment"]);
  });

  it("an unready issue never triggers a lookup or a write", async () => {
    const linearClient = fakeLinearClient({
      member: { id: "user-adam", name: "Adam Moore", active: true, isApp: false, teamKeys: [TEAM_KEY] },
    });
    const ownerAssignment = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });

    const results = await promoteEligible(
      [backlogIssue({ labels: ["human-only"] })],
      { linearClient, readyForAgentStateId: "state-ready", isBlockerSatisfied: ALL_SATISFIED, ownerAssignment },
    );

    expect(results).toMatchObject([{ issue: "MOV-1", promoted: false }]);
    expect(linearClient.log).toEqual([]);
  });
});
