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

const ALL_SATISFIED = () => true;

describe("evaluatePromotion", () => {
  it("promotes a Backlog issue that meets every clause", () => {
    const v = evaluatePromotion(issue(), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v.promote).toBe(true);
  });

  it("rejects a non-promotable state", () => {
    const v = evaluatePromotion(issue({ stateName: "Spec Ready" }), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v).toEqual({ promote: false, reason: 'state "Spec Ready" is not auto-promotable' });
  });

  it("rejects human-only", () => {
    const v = evaluatePromotion(issue({ labels: ["human-only", "area:process"] }), { isBlockerSatisfied: ALL_SATISFIED });
    expect(v.promote).toBe(false);
    expect(v.reason).toMatch(/human-only/);
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
    const v = evaluatePromotion(issue({ blockedByIds: ["id-blocker"] }), { isBlockerSatisfied });
    expect(v).toEqual({ promote: false, reason: "unresolved blocker(s): id-blocker" });
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
      { issue: "MOV-1", promoted: true, reason: expect.any(String) },
      { issue: "MOV-2", promoted: false, reason: expect.stringMatching(/human-only/) },
    ]);
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
});
