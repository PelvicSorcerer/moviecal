// MOV-508: with the real owner and delegate assigners wired as cmdPromoteOnce
// wires them, assignee and delegate are both written (and verified) strictly
// before the Ready for Agent transition.
import { describe, it, expect } from "vitest";
import { promoteEligible } from "../src/promoter.mjs";
import { createOwnerAssigner } from "../src/owner-assignment.mjs";
import { createDelegateAssigner } from "../src/delegate-assignment.mjs";

const READY = ["## Acceptance criteria", "- it works.", "", "### Testing Expectations", "- unit: covers it."].join("\n");

describe("MOV-508: owner and delegate land before Ready for Agent", () => {
  it("orders lookup, assign, delegate, transition, comment", async () => {
    const log = [];
    const linearClient = {
      async workspaceMemberByEmail() {
        log.push("workspaceMemberByEmail");
        return { id: "user-adam", name: "Adam", active: true, isApp: false, teamKeys: ["MOV"] };
      },
      async assignIssue(_i, assigneeId) {
        log.push("assignIssue");
        return { success: true, assigneeId };
      },
      async delegateIssue(_i, delegateId) {
        log.push("delegateIssue");
        return { success: true, delegateId };
      },
      async moveToState() {
        log.push("moveToState");
      },
      async addComment() {
        log.push("addComment");
      },
    };
    const results = await promoteEligible(
      [
        {
          id: "id-1",
          identifier: "MOV-1",
          stateName: "Backlog",
          description: READY,
          labels: ["execution:mac"],
          blockedByIds: [],
          recentComments: [],
          assignee: null,
          delegate: null,
        },
      ],
      {
        linearClient,
        readyForAgentStateId: "state-ready",
        isBlockerSatisfied: () => true,
        ownerAssignment: createOwnerAssigner({ linearClient, teamKey: "MOV", ownerEmail: "adam@example.com" }),
        delegateAssignment: createDelegateAssigner({ linearClient, delegate: { id: "actor-1", name: "moviecal-dispatcher" } }),
      },
    );
    expect(results).toMatchObject([{ promoted: true, ownerAssigned: true, delegateAssigned: true }]);
    expect(log).toEqual(["workspaceMemberByEmail", "assignIssue", "delegateIssue", "moveToState", "addComment"]);
  });
});
