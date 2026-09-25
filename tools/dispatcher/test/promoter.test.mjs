import { describe, it, expect, vi } from "vitest";
import {
  evaluatePromotion,
  promoteEligible,
  lastPreflightFailureReason,
  PROMOTION_COMMENT,
} from "../src/promoter.mjs";

const READY_SECTIONS = [
  "## Acceptance criteria",
  "- The thing works.",
  "",
  "### Testing Expectations",
  "- unit: covers the thing.",
].join("\n");

function issue(overrides = {}) {
  return {
    id: "id-self",
    identifier: "MOV-900",
    stateName: "Backlog",
    description: READY_SECTIONS,
    labels: [],
    blockedByIds: [],
    recentComments: [],
    ...overrides,
  };
}

// MOV-303: a fully specced dispatchable issue, so the completeness gate has
// nothing to say about it in any mode. Every pre-MOV-303 test above uses the
// deliberately under-labeled `issue()` and relies on the default `report`
// mode leaving promotion behavior exactly as it was.
const COMPLETE_SPEC = {
  labels: ["execution:mac", "type:feat", "risk:low", "worker:any", "model:default", "area:process"],
  project: "Autonomous local-agent delivery",
  projectStatus: "started",
  projectMilestoneCount: 1,
  milestone: "Local acceptance & controlled autonomy",
};

const complete = (overrides = {}) => issue({ ...COMPLETE_SPEC, ...overrides });

const ALL_SATISFIED = () => true;

describe("evaluatePromotion", () => {
  it("promotes a Backlog issue that meets every clause", () => {
    const v = evaluatePromotion(issue(), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v.promote).toBe(true);
  });

  it("rejects a non-promotable state", () => {
    const v = evaluatePromotion(complete({ stateName: "Spec Ready" }), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v).toEqual({ promote: false, reason: 'state "Spec Ready" is not auto-promotable', specViolations: [] });
  });

  it("rejects human-only", () => {
    const v = evaluatePromotion(issue({ labels: ["human-only", "area:process"] }), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v.promote).toBe(false);
    expect(v.reason).toMatch(/human-only/);
  });

  it("rejects a coordination parent (type:coordination) even with a complete description", () => {
    const v = evaluatePromotion(issue({ labels: ["type:coordination"] }), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v.promote).toBe(false);
    expect(v.reason).toMatch(/coordination issue/);
  });

  it("promotes an ordinary issue with no execution:* label (route enforcement is MOV-143, not the promoter)", () => {
    const v = evaluatePromotion(issue({ labels: [] }), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v.promote).toBe(true);
  });

  it("rejects a missing acceptance-criteria section", () => {
    const v = evaluatePromotion(
      issue({ description: "### Testing Expectations\n- unit: yes." }),
      { isBlockerSatisfied: ALL_SATISFIED },
    );
    expect(v.reason).toMatch(/acceptance-criteria/);
  });

  it("rejects an empty acceptance-criteria section", () => {
    const v = evaluatePromotion(
      issue({ description: "## Acceptance criteria\n\n## Testing Expectations\n- unit: yes." }),
      { isBlockerSatisfied: ALL_SATISFIED },
    );
    expect(v.reason).toMatch(/acceptance-criteria/);
  });

  it("rejects a missing Testing Expectations section", () => {
    const v = evaluatePromotion(
      issue({ description: "## Acceptance criteria\n- it works." }),
      { isBlockerSatisfied: ALL_SATISFIED },
    );
    expect(v.reason).toMatch(/Testing Expectations/);
  });

  it("accepts headings at any level and with trailing words", () => {
    const v = evaluatePromotion(
      issue({ description: "###### acceptance criteria (draft)\n- ok\n# Testing Expectations and coverage\n- unit" }),
      { isBlockerSatisfied: ALL_SATISFIED },
    );
    expect(v.promote).toBe(true);
  });

  it("rejects when a blocker is unresolved", () => {
    const isBlockerSatisfied = (id) => id !== "id-blocker";
    const v = evaluatePromotion(complete({ blockedByIds: ["id-blocker"] }), { isBlockerSatisfied });
    expect(v).toEqual({ promote: false, reason: "unresolved blocker(s): id-blocker", specViolations: [] });
  });

  it("promotes when every blocker is resolved", () => {
    const v = evaluatePromotion(issue({ blockedByIds: ["a", "b"] }), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v.promote).toBe(true);
  });

  describe("Blocked state", () => {
    const relComment = "**Dispatcher preflight failed:** blocked by unresolved relation(s): id-125";
    const secretComment = "**Dispatcher preflight failed:** labeled needs-secrets: required local secret 'X' is not present";

    it("re-promotes a Blocked issue whose relation block is now resolved", () => {
      const v = evaluatePromotion(
        issue({ stateName: "Blocked", blockedByIds: ["id-125"], recentComments: ["chatter", relComment, "more chatter"] }),
        { isBlockerSatisfied: ALL_SATISFIED },
      );
      expect(v.promote).toBe(true);
    });

    it("leaves a Blocked issue that was blocked for a missing secret", () => {
      const v = evaluatePromotion(
        issue({ stateName: "Blocked", recentComments: [secretComment] }),
        { isBlockerSatisfied: ALL_SATISFIED },
      );
      expect(v.promote).toBe(false);
      expect(v.reason).toMatch(/non-relation reason/);
    });

    it("leaves a Blocked issue with no preflight-failure comment", () => {
      const v = evaluatePromotion(
        issue({ stateName: "Blocked", recentComments: ["a human wrote this"] }),
        { isBlockerSatisfied: ALL_SATISFIED },
      );
      expect(v.promote).toBe(false);
      expect(v.reason).toMatch(/no dispatcher preflight-failure comment/);
    });

    it("uses the most recent preflight-failure comment", () => {
      const v = evaluatePromotion(
        issue({ stateName: "Blocked", recentComments: [secretComment, relComment] }),
        { isBlockerSatisfied: ALL_SATISFIED },
      );
      expect(v.promote).toBe(true);
    });
  });

  // MOV-303: the issue-completeness gate.
  describe("issue-completeness modes (MOV-303)", () => {
    const evaluate = (issueArg, issueSpecMode) =>
      evaluatePromotion(issueArg, { isBlockerSatisfied: ALL_SATISFIED, issueSpecMode });

    it("promotes a complete issue in every mode, with no violations reported", () => {
      for (const mode of ["off", "report", "enforce", undefined]) {
        const v = evaluate(complete(), mode);
        expect(v.promote, String(mode)).toBe(true);
        expect(v.specViolations, String(mode)).toEqual([]);
      }
    });

    it("off: ignores the contract entirely and reports nothing", () => {
      const v = evaluate(issue({ labels: [], project: null }), "off");
      expect(v.promote).toBe(true);
      expect(v.specViolations).toEqual([]);
    });

    it("report: promotes an incomplete issue exactly as before, but returns the violations", () => {
      const v = evaluate(issue({ labels: [], project: null }), "report");
      expect(v.promote).toBe(true);
      expect(v.reason).toMatch(/acceptance criteria ✓/);
      expect(v.specViolations).toContain("no `execution:*` label");
      expect(v.specViolations).toContain("no project — every non-`Triage` issue must belong to a project");
    });

    it("report is the default, so wiring nothing changes promotion behavior", () => {
      const withoutMode = evaluatePromotion(issue({ labels: [], project: null }), { isBlockerSatisfied: ALL_SATISFIED });
      const asReport = evaluate(issue({ labels: [], project: null }), "report");
      expect(withoutMode).toEqual(asReport);
      expect(withoutMode.promote).toBe(true);
    });

    it("enforce: refuses an incomplete issue and names every missing item", () => {
      const v = evaluate(issue({ labels: ["execution:mac", "type:feat", "area:process"], project: null }), "enforce");
      expect(v.promote).toBe(false);
      expect(v.reason).toMatch(/^incomplete issue spec \(MOV-303\): /);
      expect(v.reason).toContain("no `risk:*` label");
      expect(v.reason).toContain("no `worker:*` label");
      expect(v.reason).toContain("no `model:*` label");
      expect(v.reason).toContain("no project");
      expect(v.specViolations).toHaveLength(4);
    });

    it("enforce: refuses model:strong with no upgrade:* condition at intake, not at dispatch", () => {
      const v = evaluate(
        complete({ labels: ["execution:mac", "type:feat", "risk:low", "worker:any", "model:strong", "area:process"] }),
        "enforce",
      );
      expect(v.promote).toBe(false);
      expect(v.reason).toMatch(/model:strong requires an upgrade-condition label/);
    });

    it("enforce: refuses an issue whose project has milestones but which sets none", () => {
      const v = evaluate(complete({ milestone: null }), "enforce");
      expect(v.promote).toBe(false);
      expect(v.reason).toMatch(/no milestone/);
    });

    it("enforce: accepts the explicit milestone opt-out", () => {
      const v = evaluate(
        complete({ milestone: null, description: `${READY_SECTIONS}\n\nMilestone: N/A — cross-cutting, no phase applies.` }),
        "enforce",
      );
      expect(v.promote).toBe(true);
    });

    it("reports violations even on an issue that is rejected for an unrelated reason", () => {
      // A human-only issue never promotes, but it is still subject to the
      // contract -- and the audit pass is the only thing that will ever tell
      // anyone, so the violations must survive this early return.
      const v = evaluate(issue({ labels: ["human-only"], project: null }), "report");
      expect(v.promote).toBe(false);
      expect(v.reason).toMatch(/human-only/);
      expect(v.specViolations.length).toBeGreaterThan(0);
    });
  });
});

describe("lastPreflightFailureReason", () => {
  it("returns the newest matching reason, or null", () => {
    expect(lastPreflightFailureReason([])).toBeNull();
    expect(lastPreflightFailureReason(["nope"])).toBeNull();
    expect(
      lastPreflightFailureReason([
        "**Dispatcher preflight failed:** old reason",
        "unrelated",
        "**Dispatcher preflight failed:** new reason",
      ]),
    ).toBe("new reason");
  });
});

describe("promoteEligible", () => {
  function fakeClient() {
    return { moveToState: vi.fn().mockResolvedValue(true), addComment: vi.fn().mockResolvedValue(true) };
  }
  const ctxBase = (linearClient, extra = {}) => ({
    linearClient,
    readyForAgentStateId: "state-ready",
    isBlockerSatisfied: ALL_SATISFIED,
    ...extra,
  });

  it("promotes eligible issues once each: moveToState then addComment", async () => {
    const client = fakeClient();
    const results = await promoteEligible(
      [issue({ id: "id-1", identifier: "MOV-1" }), issue({ id: "id-2", identifier: "MOV-2", labels: ["human-only"] })],
      ctxBase(client),
    );

    expect(client.moveToState).toHaveBeenCalledTimes(1);
    expect(client.moveToState).toHaveBeenCalledWith("id-1", "state-ready");
    expect(client.addComment).toHaveBeenCalledWith("id-1", PROMOTION_COMMENT);
    expect(results).toEqual([
      { issue: "MOV-1", promoted: true, reason: expect.any(String), specViolations: expect.any(Array) },
      { issue: "MOV-2", promoted: false, reason: expect.stringMatching(/human-only/), specViolations: expect.any(Array) },
    ]);
  });

  it("passes the issue-spec mode through: enforce blocks the write, report still promotes (MOV-303)", async () => {
    const incomplete = issue({ id: "id-1", identifier: "MOV-1", labels: [], project: null });

    const enforcing = fakeClient();
    const enforced = await promoteEligible([incomplete], ctxBase(enforcing, { issueSpecMode: "enforce" }));
    expect(enforcing.moveToState).not.toHaveBeenCalled();
    expect(enforcing.addComment).not.toHaveBeenCalled();
    expect(enforced[0]).toMatchObject({ promoted: false, reason: expect.stringMatching(/incomplete issue spec/) });
    expect(enforced[0].specViolations.length).toBeGreaterThan(0);

    const reporting = fakeClient();
    const reported = await promoteEligible([incomplete], ctxBase(reporting, { issueSpecMode: "report" }));
    expect(reporting.moveToState).toHaveBeenCalledWith("id-1", "state-ready");
    expect(reported[0].promoted).toBe(true);
    // Reported, not enforced: the caller logs these, nothing is blocked.
    expect(reported[0].specViolations.length).toBeGreaterThan(0);
  });

  it("dry-run evaluates but writes nothing", async () => {
    const client = fakeClient();
    const results = await promoteEligible([issue({ id: "id-1", identifier: "MOV-1" })], ctxBase(client, { dryRun: true }));
    expect(client.moveToState).not.toHaveBeenCalled();
    expect(client.addComment).not.toHaveBeenCalled();
    expect(results[0].promoted).toBe(true);
  });

  it("is a no-op on a second pass (promoted issue no longer in the input set)", async () => {
    const client = fakeClient();
    await promoteEligible([issue({ id: "id-1", identifier: "MOV-1" })], ctxBase(client));
    // Second pass: the issue is now Ready for Agent and would not be returned by
    // issuesForPromotion; even if it leaks in, the guard skips it.
    const results = await promoteEligible(
      [issue({ id: "id-1", identifier: "MOV-1", stateName: "Ready for Agent" })],
      ctxBase(client),
    );
    expect(client.moveToState).toHaveBeenCalledTimes(1); // unchanged from the first pass
    expect(results).toEqual([]);
  });

  // MOV-359: the configured-human-owner gate.
  describe("owner assignment (MOV-359)", () => {
    function fakeOwnerAssignment(ensureOwnerImpl) {
      return { ensureOwner: vi.fn(ensureOwnerImpl) };
    }
    const OK_ASSIGNED = { ok: true, assigned: true, wouldAssign: false, member: { id: "user-adam", name: "Adam Moore" } };
    const OK_PLANNED = { ok: true, assigned: false, wouldAssign: true, member: { id: "user-adam", name: "Adam Moore" } };
    const NOT_CONFIGURED = { ok: false, reason: "no default owner configured (MOVIECAL_DEFAULT_OWNER_EMAIL is unset)" };

    it("assigns the owner before moving to Ready for Agent, then promotes", async () => {
      const client = fakeClient();
      const calls = [];
      client.moveToState.mockImplementation(async (...args) => { calls.push(["moveToState", ...args]); });
      const ownerAssignment = fakeOwnerAssignment(async (issueArg) => { calls.push(["ensureOwner", issueArg.id]); return OK_ASSIGNED; });

      const results = await promoteEligible([issue({ id: "id-1", identifier: "MOV-1" })], ctxBase(client, { ownerAssignment }));

      expect(calls).toEqual([["ensureOwner", "id-1"], ["moveToState", "id-1", "state-ready"]]);
      expect(results).toEqual([
        {
          issue: "MOV-1",
          promoted: true,
          reason: expect.any(String),
          specViolations: expect.any(Array),
          ownerAssigned: true,
          ownerPlanned: false,
          ownerName: "Adam Moore",
        },
      ]);
    });

    it("never calls ensureOwner when the issue already has an assignee", async () => {
      const client = fakeClient();
      const ownerAssignment = fakeOwnerAssignment(async () => OK_ASSIGNED);
      const results = await promoteEligible(
        [issue({ id: "id-1", identifier: "MOV-1", assignee: { id: "user-existing", name: "Someone Else" } })],
        ctxBase(client, { ownerAssignment }),
      );
      expect(ownerAssignment.ensureOwner).not.toHaveBeenCalled();
      expect(client.moveToState).toHaveBeenCalledWith("id-1", "state-ready");
      expect(results[0]).toMatchObject({ promoted: true });
      expect(results[0].ownerAssigned).toBeUndefined();
    });

    it("never calls ensureOwner for an issue that is not otherwise promotable", async () => {
      const client = fakeClient();
      const ownerAssignment = fakeOwnerAssignment(async () => OK_ASSIGNED);
      const results = await promoteEligible(
        [issue({ id: "id-1", identifier: "MOV-1", labels: ["human-only"] })],
        ctxBase(client, { ownerAssignment }),
      );
      expect(ownerAssignment.ensureOwner).not.toHaveBeenCalled();
      expect(client.moveToState).not.toHaveBeenCalled();
      expect(results[0].promoted).toBe(false);
    });

    it("withholds promotion when owner assignment fails, and never comments", async () => {
      const client = fakeClient();
      const ownerAssignment = fakeOwnerAssignment(async () => NOT_CONFIGURED);
      const results = await promoteEligible([issue({ id: "id-1", identifier: "MOV-1" })], ctxBase(client, { ownerAssignment }));

      expect(client.moveToState).not.toHaveBeenCalled();
      expect(client.addComment).not.toHaveBeenCalled();
      expect(results[0]).toMatchObject({
        promoted: false,
        reason: expect.stringMatching(/^owner assignment: no default owner configured/),
      });
    });

    it("dry-run reports the planned owner assignment without assigning or promoting", async () => {
      const client = fakeClient();
      const ownerAssignment = fakeOwnerAssignment(async (_issue, opts) => {
        expect(opts).toMatchObject({ dryRun: true });
        return OK_PLANNED;
      });
      const results = await promoteEligible(
        [issue({ id: "id-1", identifier: "MOV-1" })],
        ctxBase(client, { ownerAssignment, dryRun: true }),
      );
      expect(client.moveToState).not.toHaveBeenCalled();
      expect(results[0]).toMatchObject({ promoted: true, ownerAssigned: false, ownerPlanned: true, ownerName: "Adam Moore" });
    });

    it("repeated runs do not re-assign or duplicate writes once the issue carries the owner", async () => {
      const client = fakeClient();
      const ownerAssignment = fakeOwnerAssignment(async () => OK_ASSIGNED);

      await promoteEligible([issue({ id: "id-1", identifier: "MOV-1" })], ctxBase(client, { ownerAssignment }));
      expect(ownerAssignment.ensureOwner).toHaveBeenCalledTimes(1);
      expect(client.moveToState).toHaveBeenCalledTimes(1);

      // A fresh promote pass reads the issue back with the assignee now set
      // (as a real issuesForPromotion() re-fetch would) and in "Ready for
      // Agent" (so the idempotency guard also applies) -- neither write repeats.
      const results = await promoteEligible(
        [issue({ id: "id-1", identifier: "MOV-1", stateName: "Ready for Agent", assignee: { id: "user-adam" } })],
        ctxBase(client, { ownerAssignment }),
      );
      expect(results).toEqual([]);
      expect(ownerAssignment.ensureOwner).toHaveBeenCalledTimes(1);
      expect(client.moveToState).toHaveBeenCalledTimes(1);
      expect(client.addComment).toHaveBeenCalledTimes(1);
    });
  });
});
