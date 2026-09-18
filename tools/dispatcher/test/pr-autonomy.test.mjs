import { describe, expect, it, vi } from "vitest";
import {
  applyPrAutonomy,
  evaluatePrAutonomy,
  PrAutonomyLedger,
  runPrAutonomyPass,
} from "../src/pr-autonomy.mjs";

const repo = "owner/repo";
const issue = {
  id: "issue-1",
  identifier: "MOV-1",
  stateName: "In Review",
  labels: ["agent-ready", "risk:low", "execution:mac"],
};
const body = [
  "Autonomy: eligible",
  "Human testing: not-required",
  "- Local-agent evidence: npm run verify (passed)",
  "- No-human-testing rationale: docs-only change with deterministic CI coverage.",
].join("\n");

function observation(overrides = {}) {
  return {
    state: "OPEN",
    isDraft: true,
    headSha: "new-sha",
    headBranch: "agent/MOV-1-docs",
    headRepository: repo,
    body,
    changedFiles: ["docs/operators/local-execution.md"],
    checks: {
      pending: false,
      timedOut: false,
      ignoredStale: 0,
      missingRequired: [],
      checks: ["lane-baseline", "lane-unit", "lane-integration", "lane-browser", "lane-review"].map((name) => ({ name, sha: "new-sha", outcome: "success" })),
      required: [{ name: "lane-unit", sha: "new-sha", outcome: "success" }],
    },
    review: { decision: null, requestedChanges: [], blockingRequiredChecks: [] },
    ...overrides,
  };
}

describe("MOV-162 PR autonomy policy", () => {
  it("allows only an explicitly evidenced, low-risk local docs draft", () => {
    expect(evaluatePrAutonomy({ issue, observation: observation(), repo, enabled: true })).toMatchObject({ eligible: true, action: "ready" });
  });

  it("uses the required review check policy and blocks requested changes before auto-merge", () => {
    expect(evaluatePrAutonomy({ issue, observation: observation({ isDraft: false }), repo, enabled: true })).toMatchObject({ eligible: true, action: "merge" });
    expect(evaluatePrAutonomy({ issue, observation: observation({ isDraft: false, review: { decision: "CHANGES_REQUESTED", requestedChanges: [], blockingRequiredChecks: [] } }), repo, enabled: true }).reason).toMatch(/blocking review/);
  });

  it.each([
    ["global kill switch", {}, observation(), false, /switch is disabled/],
    ["human-only issue", { labels: [...issue.labels, "human-only"] }, observation(), true, /human or sensitive/],
    ["per-issue kill switch", { description: "Autonomy: disabled" }, observation(), true, /kill switch/],
    ["cloud route", { labels: ["agent-ready", "risk:low", "execution:cloud"] }, observation(), true, /allowlist/],
    ["manual evidence", {}, observation({ body: "Autonomy: eligible\nHuman testing: required" }), true, /evidence/],
    ["sensitive path", {}, observation({ changedFiles: ["src/app/api/calendar/route.ts"] }), true, /docs-only/],
    ["stale SHA", {}, observation({ checks: { ...observation().checks, ignoredStale: 1 } }), true, /stale/],
    ["missing check", {}, observation({ checks: { ...observation().checks, missingRequired: ["lane-unit"] } }), true, /incomplete/],
    ["old check SHA", {}, observation({ checks: { ...observation().checks, checks: observation().checks.checks.map((check) => check.name === "lane-unit" ? { ...check, sha: "old" } : check) } }), true, /latest SHA/],
  ])("denies %s", (_name, issueOverrides, observed, enabled, reason) => {
    expect(evaluatePrAutonomy({ issue: { ...issue, ...issueOverrides }, observation: observed, repo, enabled }).reason).toMatch(reason);
  });

  it("blocks any PR with repair activity", () => {
    expect(evaluatePrAutonomy({ issue, observation: observation(), repo, enabled: true, repairAttempts: [{ kind: "code-repair" }] }).reason).toMatch(/repair activity/);
  });
});

describe("MOV-162 action bounds", () => {
  it("uses only normal GitHub ready and auto-merge commands", () => {
    const runner = vi.fn();
    applyPrAutonomy({ action: "ready", prNumber: 3, repo, runner });
    applyPrAutonomy({ action: "merge", prNumber: 3, repo, runner });
    expect(runner.mock.calls).toEqual([
      ["gh", ["pr", "ready", "3", "--repo", repo]],
      ["gh", ["pr", "merge", "3", "--auto", "--merge", "--repo", repo]],
    ]);
  });

  it("reserves before acting and never retries the same PR SHA/action", async () => {
    const saved = {};
    const ledger = {
      has: vi.fn(() => false), count: vi.fn(() => 0), reserve: vi.fn(), complete: vi.fn(),
    };
    const runner = vi.fn();
    const manager = { loadState: () => saved };
    saved["MOV-1"] = { id: "MOV-1", status: "review", prNumber: 7 };
    const first = await runPrAutonomyPass({ issues: [issue], worktreeManager: manager, observePrFn: () => observation(), repo, ledger, enabled: true, maxActions: 1, runner });
    expect(first[0].action).toBe("ready");
    expect(ledger.reserve).toHaveBeenCalledBefore(runner);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
