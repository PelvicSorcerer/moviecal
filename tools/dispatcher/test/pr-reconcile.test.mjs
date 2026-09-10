import { describe, it, expect } from "vitest";
import {
  aggregateCheckResults,
  checkPrObservation,
  checkPrState,
  normalizeCheckOutcome,
  observePullRequest,
  reconcileReviewWorktrees,
} from "../src/pr-reconcile.mjs";

describe("normalizeCheckOutcome", () => {
  it.each([
    [{ status: "QUEUED" }, "pending"],
    [{ status: "IN_PROGRESS" }, "pending"],
    [{ conclusion: "SUCCESS" }, "success"],
    [{ conclusion: "FAILURE" }, "failure"],
    [{ conclusion: "TIMED_OUT" }, "timed-out"],
    [{ conclusion: "CANCELLED" }, "canceled"],
    [{ conclusion: "SKIPPED" }, "skipped"],
    [{ conclusion: "NEUTRAL" }, "neutral"],
    [{ logsAvailable: false }, "unavailable-log"],
  ])("normalizes %j to %s", (check, expected) => {
    expect(normalizeCheckOutcome(check)).toBe(expected);
  });
});

describe("aggregateCheckResults", () => {
  it("rolls up out-of-order duplicates for the current SHA and ignores stale/optional failures", () => {
    const result = aggregateCheckResults({
      headSha: "new",
      requiredChecks: ["build"],
      checks: [
        { name: "optional-lint", sha: "new", conclusion: "FAILURE" },
        { name: "build", sha: "new", status: "IN_PROGRESS" },
        { name: "build", sha: "old", conclusion: "FAILURE" },
        { name: "build", sha: "new", conclusion: "SUCCESS" },
      ],
    });

    expect(result.required).toEqual([expect.objectContaining({ name: "build", outcome: "success", required: true, sha: "new" })]);
    expect(result.ignoredStale).toBe(1);
    expect(result.actionable).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "optional-lint", outcome: "failure", required: false }),
    ]));
  });

  it("keeps required checks pending until terminal or an explicit timeout", () => {
    const pending = aggregateCheckResults({
      headSha: "sha",
      requiredChecks: ["external"],
      checks: [{ name: "external", sha: "sha", status: "PENDING", logsAvailable: false }],
    });
    expect(pending.pending).toBe(true);
    expect(pending.terminal).toBe(false);
    expect(pending.actionable).toBe(false);
    expect(pending.required[0]).toMatchObject({ outcome: "pending", logAvailable: false });

    const timedOut = aggregateCheckResults({
      headSha: "sha",
      requiredChecks: ["external"],
      checks: [{ name: "external", sha: "sha", status: "PENDING", logsAvailable: false }],
      timeoutAt: "2020-01-01T00:00:00Z",
      now: new Date("2020-01-02T00:00:00Z").getTime(),
    });
    expect(timedOut).toMatchObject({ pending: false, timedOut: true, terminal: true, actionable: false });
  });
});

describe("observePullRequest", () => {
  it("keeps human changes, blocking review checks, and advisory comments distinct", () => {
    const observation = observePullRequest({
      pr: { state: "OPEN", isDraft: false, headRefOid: "sha", reviewDecision: "CHANGES_REQUESTED" },
      requiredChecks: ["review-gate"],
      checks: [{ name: "review-gate", sha: "sha", conclusion: "FAILURE" }],
      reviews: [{ state: "REQUEST_CHANGES", body: "Please revise" }],
      comments: [{ body: "Looks good", required: false }],
    });
    expect(observation.actionable).toBe(true);
    expect(observation.review.requestedChanges).toHaveLength(1);
    expect(observation.review.blockingRequiredChecks).toHaveLength(1);
    expect(observation.review.advisoryComments).toHaveLength(1);
  });

  it("does not make a draft actionable", () => {
    expect(observePullRequest({
      pr: { state: "OPEN", isDraft: true, headRefOid: "sha" },
      requiredChecks: ["build"],
      checks: [{ name: "build", sha: "sha", conclusion: "FAILURE" }],
    }).actionable).toBe(false);
  });
});

describe("checkPrObservation", () => {
  it("returns a recoverable observation error for CLI/API parse failures", () => {
    const result = checkPrObservation(42, "owner/repo", () => "not json");
    expect(result).toEqual({
      observationError: { recoverable: true, message: expect.any(String) },
      state: "UNAVAILABLE",
      actionable: false,
    });
  });

  it("reads PR data and required contexts without mutating repository state", () => {
    const calls = [];
    const runner = (command, args) => {
      calls.push([command, args]);
      if (args[0] === "pr") return JSON.stringify({
        state: "OPEN", isDraft: false, headRefOid: "sha", baseRefName: "master",
        statusCheckRollup: [{ name: "build", sha: "sha", conclusion: "FAILURE" }],
      });
      return JSON.stringify({ contexts: ["build"] });
    };
    const result = checkPrObservation(42, "owner/repo", runner);
    expect(result).toMatchObject({ state: "OPEN", headSha: "sha", actionable: true });
    expect(calls).toHaveLength(2);
    expect(calls[1][1][1]).toBe("repos/owner/repo/branches/master/protection/required_status_checks");
  });
});

describe("checkPrState", () => {
  it("calls gh pr view with the expected args and parses the result", () => {
    const runner = (cmd, args) => {
      expect(cmd).toBe("gh");
      expect(args).toEqual(["pr", "view", "42", "--repo", "owner/repo", "--json", "state,mergedAt"]);
      return JSON.stringify({ state: "MERGED", mergedAt: "2026-09-08T00:00:00Z" });
    };

    expect(checkPrState(42, "owner/repo", runner)).toEqual({ state: "MERGED", mergedAt: "2026-09-08T00:00:00Z" });
  });

  it("normalizes a missing mergedAt to null", () => {
    const runner = () => JSON.stringify({ state: "OPEN" });
    expect(checkPrState(1, "owner/repo", runner)).toEqual({ state: "OPEN", mergedAt: null });
  });
});

describe("reconcileReviewWorktrees", () => {
  function fakeManager(initialState) {
    let state = structuredClone(initialState);
    return {
      loadState: () => structuredClone(state),
      markStatus: (id, status) => {
        state[id] = { ...state[id], status };
      },
      _finalState: () => state,
    };
  }

  it("marks a merged PR's worktree as merged", () => {
    const manager = fakeManager({
      "MOV-1": { id: "MOV-1", status: "review", prNumber: 42 },
    });
    const checkPrStateFn = () => ({ state: "MERGED", mergedAt: "2026-09-08T00:00:00Z" });

    const changes = reconcileReviewWorktrees(manager, { ghRepo: "owner/repo", checkPrStateFn });

    expect(changes).toEqual([{ id: "MOV-1", prNumber: 42, from: "review", to: "merged" }]);
    expect(manager._finalState()["MOV-1"].status).toBe("merged");
  });

  it("marks a closed-without-merging PR's worktree as abandoned", () => {
    const manager = fakeManager({
      "MOV-1": { id: "MOV-1", status: "review", prNumber: 7 },
    });
    const checkPrStateFn = () => ({ state: "CLOSED", mergedAt: null });

    const changes = reconcileReviewWorktrees(manager, { ghRepo: "owner/repo", checkPrStateFn });

    expect(changes).toEqual([{ id: "MOV-1", prNumber: 7, from: "review", to: "abandoned" }]);
    expect(manager._finalState()["MOV-1"].status).toBe("abandoned");
  });

  it("leaves a still-open PR's worktree alone", () => {
    const manager = fakeManager({
      "MOV-1": { id: "MOV-1", status: "review", prNumber: 9 },
    });
    const checkPrStateFn = () => ({ state: "OPEN", mergedAt: null });

    const changes = reconcileReviewWorktrees(manager, { ghRepo: "owner/repo", checkPrStateFn });

    expect(changes).toEqual([]);
    expect(manager._finalState()["MOV-1"].status).toBe("review");
  });

  it("skips entries not in review status", () => {
    const manager = fakeManager({
      "MOV-1": { id: "MOV-1", status: "active", prNumber: 1 },
      "MOV-2": { id: "MOV-2", status: "merged", prNumber: 2 },
    });
    let called = false;
    const checkPrStateFn = () => {
      called = true;
      return { state: "MERGED", mergedAt: null };
    };

    const changes = reconcileReviewWorktrees(manager, { ghRepo: "owner/repo", checkPrStateFn });

    expect(changes).toEqual([]);
    expect(called).toBe(false);
  });

  it("skips review entries with no recorded prNumber", () => {
    const manager = fakeManager({
      "MOV-1": { id: "MOV-1", status: "review" },
    });
    let called = false;
    const checkPrStateFn = () => {
      called = true;
      return { state: "MERGED", mergedAt: null };
    };

    const changes = reconcileReviewWorktrees(manager, { ghRepo: "owner/repo", checkPrStateFn });

    expect(changes).toEqual([]);
    expect(called).toBe(false);
  });
});
