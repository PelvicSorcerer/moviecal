import { describe, expect, it, vi } from "vitest";
import { runPrAutonomyPass } from "../src/pr-autonomy.mjs";
import { reconcileReviewWorktrees } from "../src/pr-reconcile.mjs";

const REPO = "owner/repo";
const BODY = [
  "Human testing: not-required",
  "Autonomy: eligible",
  "- Local-agent evidence: `npm run verify` passed; durable dispatcher record: `/logs/MOV-1/verification-evidence.json`.",
  "- No-human-testing rationale: deterministic coverage covers every acceptance criterion.",
].join("\n");

function observation(isDraft) {
  return {
    state: "OPEN", isDraft, headSha: "sha-1", headBranch: "agent/MOV-1-docs", headRepository: REPO, body: BODY,
    changedFiles: ["docs/technical/architecture.md"],
    checks: {
      pending: false, timedOut: false, ignoredStale: 0, missingRequired: [],
      checks: ["lane-baseline", "lane-unit", "lane-integration", "lane-browser", "lane-review", "lane-ios"].map((name) => ({ name, sha: "sha-1", outcome: "success" })),
      required: [],
    },
    review: { decision: null, requestedChanges: [], blockingRequiredChecks: [] },
  };
}

describe("MOV-275 ready action and Linear state recovery", () => {
  it("persists one ready tuple then restores the observed Agent Working regression once", async () => {
    const state = {
      "MOV-1": {
        id: "MOV-1", status: "review", prNumber: 7, prUrl: "https://github.com/o/r/pull/7",
        branch: "agent/MOV-1-docs", headSha: "sha-1", linearIssueId: "linear-1",
        provenance: { executor: "moviecal-dispatcher", repository: REPO },
      },
    };
    const manager = {
      loadState: () => structuredClone(state),
      updateEntry: (id, extra) => { state[id] = { ...state[id], ...extra }; },
      markStatus: vi.fn(),
    };
    const issue = { id: "linear-1", identifier: "MOV-1", stateName: "In Review", labels: ["agent-ready", "risk:low", "execution:mac"] };
    const ledger = { has: () => false, count: () => 0, reserve: vi.fn(), complete: vi.fn() };
    const linearClient = {
      addComment: vi.fn(async () => {}),
      issueSnapshot: vi.fn(async () => ({ stateName: "Agent Working" })),
      moveToState: vi.fn(async () => {}),
    };

    const actions = await runPrAutonomyPass({
      issues: [issue], worktreeManager: manager, observePrFn: () => observation(true), repo: REPO,
      ledger, enabled: true, maxActions: 1, runner: vi.fn(), linearClient,
    });
    expect(actions).toMatchObject([{ action: "ready" }]);
    expect(state["MOV-1"].prAutonomyReady).toMatchObject({ prNumber: 7, headSha: "sha-1", branch: "agent/MOV-1-docs", repository: REPO });

    await reconcileReviewWorktrees(manager, { ghRepo: REPO, observePrFn: () => observation(false), linearClient, inReviewStateId: "in-review" });
    expect(linearClient.moveToState).toHaveBeenCalledWith("linear-1", "in-review");
    expect(state["MOV-1"].prAutonomyReady.reconciledAt).toEqual(expect.any(String));

    await reconcileReviewWorktrees(manager, { ghRepo: REPO, observePrFn: () => observation(false), linearClient, inReviewStateId: "in-review" });
    expect(linearClient.moveToState).toHaveBeenCalledTimes(1);
  });
});
