import { describe, it, expect } from "vitest";
import { checkPrState, reconcileReviewWorktrees } from "../src/pr-reconcile.mjs";

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
