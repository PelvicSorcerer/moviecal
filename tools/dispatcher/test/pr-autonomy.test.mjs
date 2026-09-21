import { describe, expect, it, vi } from "vitest";
import {
  applyPrAutonomy,
  evaluatePrAutonomy,
  isAutonomySafePath,
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
  "- Local-agent evidence: `npm run verify` passed; durable dispatcher record: `/logs/MOV-1/verification-evidence.json`.",
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

describe("MOV-273 PR autonomy path policy", () => {
  it.each([
    ["documentation", "docs/operators/local-execution.md"],
    ["calendar documentation under the unchanged docs policy", "docs/calendar-feed-policy.md"],
    ["low-risk application helper", "src/lib/format-release-date.ts"],
    ["deterministic helper coverage", "test/format-release-date.test.ts"],
  ])("allows %s", (_name, file) => {
    expect(isAutonomySafePath(file)).toBe(true);
  });

  it.each([
    ["outside the explicit roots", "e2e/home.spec.ts"],
    ["dispatcher or governance code", "tools/dispatcher/src/pr-autonomy.mjs"],
    ["GitHub configuration", ".github/workflows/verify.yml"],
    ["API boundary", "src/app/api/v1/movies/route.ts"],
    ["server boundary", "src/server/release-refresh.ts"],
    ["route handler", "src/app/search/route.ts"],
    ["middleware", "src/middleware.ts"],
    ["auth implementation", "src/lib/auth/identity.ts"],
    ["sign-in page", "src/app/sign-in/page.tsx"],
    ["session implementation", "src/lib/agent-session/env.ts"],
    ["calendar/token/feed behavior", "src/lib/calendar-feed.ts"],
    ["Supabase/database behavior", "src/lib/supabase/database.ts"],
    ["real-stack coverage", "test/watchlist-memberships.real-stack.test.ts"],
    ["private watchlist data access", "src/lib/watchlist/items.ts"],
    ["cron behavior", "src/lib/cron/env.ts"],
    ["deployment behavior", "src/lib/deployment/config.ts"],
    ["security-sensitive behavior", "src/lib/security/headers.ts"],
    ["browser E2E coverage", "test/browser/search.test.ts"],
  ])("denies %s", (_name, file) => {
    expect(isAutonomySafePath(file)).toBe(false);
  });

  it("allows explicitly evidenced docs and low-risk application drafts", () => {
    expect(evaluatePrAutonomy({ issue, observation: observation(), repo, enabled: true })).toMatchObject({ eligible: true, action: "ready" });
    expect(evaluatePrAutonomy({ issue, observation: observation({
      headBranch: "agent/MOV-1-format-release-date",
      changedFiles: ["src/lib/format-release-date.ts", "test/format-release-date.test.ts"],
    }), repo, enabled: true })).toMatchObject({ eligible: true, action: "ready" });
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
    ...["area:auth", "area:calendar", "area:database", "area:deployment", "area:security", "security:review"].map((label) => [label, { labels: [...issue.labels, label] }, observation(), true, /human or sensitive/]),
    ["manual evidence", {}, observation({ body: "Autonomy: eligible\nHuman testing: required" }), true, /evidence/],
    ["non-durable local evidence", {}, observation({ body: body.replace("; durable dispatcher record: `/logs/MOV-1/verification-evidence.json`.", " (passed)") }), true, /evidence/],
    ["mixed allowed and denied paths", {}, observation({ changedFiles: ["src/lib/format-release-date.ts", "src/lib/auth/identity.ts"] }), true, /sensitive or outside-approved/],
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
    const manager = { loadState: () => saved, updateEntry: (id, extra) => { saved[id] = { ...saved[id], ...extra }; } };
    saved["MOV-1"] = { id: "MOV-1", status: "review", prNumber: 7 };
    const first = await runPrAutonomyPass({ issues: [issue], worktreeManager: manager, observePrFn: () => observation(), repo, ledger, enabled: true, maxActions: 1, runner });
    expect(first[0].action).toBe("ready");
    expect(ledger.reserve).toHaveBeenCalledBefore(runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(saved["MOV-1"].prAutonomyReady).toMatchObject({ prNumber: 7, headSha: "new-sha", branch: "agent/MOV-1-docs", repository: repo });
  });
});
