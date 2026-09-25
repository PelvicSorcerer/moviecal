import { describe, it, expect, vi } from "vitest";
import { needsOwnerAssignment, evaluateOwnerCandidate, createOwnerAssigner } from "../src/owner-assignment.mjs";

const TEAM_KEY = "MOV";
const OWNER_EMAIL = "adam@example.com";

function humanMember(overrides = {}) {
  return {
    id: "user-adam",
    name: "Adam Moore",
    email: OWNER_EMAIL,
    active: true,
    isApp: false,
    isGuest: false,
    teamKeys: [TEAM_KEY],
    ...overrides,
  };
}

describe("needsOwnerAssignment", () => {
  it("is true when the issue has no assignee", () => {
    expect(needsOwnerAssignment({ assignee: null })).toBe(true);
    expect(needsOwnerAssignment({})).toBe(true);
  });

  it("is false once the issue has an assignee with an id", () => {
    expect(needsOwnerAssignment({ assignee: { id: "user-1" } })).toBe(false);
  });

  it("is true for a malformed assignee with no id", () => {
    expect(needsOwnerAssignment({ assignee: { id: null } })).toBe(true);
  });
});

describe("evaluateOwnerCandidate", () => {
  it("accepts an active human member with team access", () => {
    const v = evaluateOwnerCandidate(humanMember(), { teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    expect(v).toEqual({ ok: true });
  });

  it("rejects when the lookup found nobody", () => {
    const v = evaluateOwnerCandidate(null, { teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not found/);
  });

  it("rejects an inactive member", () => {
    const v = evaluateOwnerCandidate(humanMember({ active: false }), { teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not an active workspace member/);
  });

  it("rejects an app/bot user", () => {
    const v = evaluateOwnerCandidate(humanMember({ isApp: true }), { teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/app\/bot user/);
  });

  it("rejects a member with no access to the target team", () => {
    const v = evaluateOwnerCandidate(humanMember({ teamKeys: ["OTHER"] }), { teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no access to team "MOV"/);
  });
});

describe("createOwnerAssigner", () => {
  function fakeClient({ member = humanMember(), assignResult = { success: true, assigneeId: member?.id } } = {}) {
    return {
      workspaceMemberByEmail: vi.fn(async () => member),
      assignIssue: vi.fn(async () => assignResult),
    };
  }

  it("fails closed without a network call when no owner is configured", async () => {
    const linearClient = fakeClient();
    const assigner = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: null });
    const outcome = await assigner.ensureOwner({ id: "id-1", identifier: "MOV-1" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/no default owner configured/);
    expect(linearClient.workspaceMemberByEmail).not.toHaveBeenCalled();
    expect(linearClient.assignIssue).not.toHaveBeenCalled();
  });

  it("assigns and verifies the readback for a valid candidate", async () => {
    const linearClient = fakeClient();
    const assigner = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    const outcome = await assigner.ensureOwner({ id: "id-1", identifier: "MOV-1" });
    expect(outcome).toMatchObject({ ok: true, assigned: true, wouldAssign: false });
    expect(outcome.member.id).toBe("user-adam");
    expect(linearClient.assignIssue).toHaveBeenCalledWith("id-1", "user-adam");
  });

  it("does not write anything in dry-run, but reports the planned assignment", async () => {
    const linearClient = fakeClient();
    const assigner = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    const outcome = await assigner.ensureOwner({ id: "id-1", identifier: "MOV-1" }, { dryRun: true });
    expect(outcome).toMatchObject({ ok: true, assigned: false, wouldAssign: true });
    expect(outcome.member.id).toBe("user-adam");
    expect(linearClient.assignIssue).not.toHaveBeenCalled();
  });

  it("fails closed when the configured owner is invalid, without attempting a write", async () => {
    const linearClient = fakeClient({ member: humanMember({ active: false }) });
    const assigner = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    const outcome = await assigner.ensureOwner({ id: "id-1", identifier: "MOV-1" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/not an active workspace member/);
    expect(linearClient.assignIssue).not.toHaveBeenCalled();
  });

  it("fails closed when the write itself reports failure", async () => {
    const linearClient = fakeClient({ assignResult: { success: false, assigneeId: null } });
    const assigner = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    const outcome = await assigner.ensureOwner({ id: "id-1", identifier: "MOV-1" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/did not verify on readback/);
  });

  it("fails closed when the write reports success but the readback assignee does not match", async () => {
    const linearClient = fakeClient({ assignResult: { success: true, assigneeId: "someone-else" } });
    const assigner = createOwnerAssigner({ linearClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    const outcome = await assigner.ensureOwner({ id: "id-1", identifier: "MOV-1" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/did not verify on readback/);
  });

  it("retries cleanly on a fresh assigner after a prior failure (no latched state)", async () => {
    const failingClient = fakeClient({ member: null });
    const failingAssigner = createOwnerAssigner({ linearClient: failingClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    const first = await failingAssigner.ensureOwner({ id: "id-1", identifier: "MOV-1" });
    expect(first.ok).toBe(false);

    // A later poll cycle builds a brand-new assigner (as cmdPromoteOnce does
    // every call) against a client that now resolves the owner correctly.
    const recoveredClient = fakeClient();
    const recoveredAssigner = createOwnerAssigner({ linearClient: recoveredClient, teamKey: TEAM_KEY, ownerEmail: OWNER_EMAIL });
    const second = await recoveredAssigner.ensureOwner({ id: "id-1", identifier: "MOV-1" });
    expect(second.ok).toBe(true);
    expect(second.assigned).toBe(true);
  });
});
