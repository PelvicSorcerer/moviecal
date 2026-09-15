import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairPass } from "../src/repair-loop.mjs";
import { RepairLedger } from "../src/repair-ledger.mjs";
import { observePullRequest } from "../src/pr-reconcile.mjs";

const REPO = "owner/repo";
const BRANCH = "agent/MOV-1-widget";
const STATE_IDS = { needsHumanDecision: "state-needs-human" };
const ISSUE = { id: "linear-uuid-1", identifier: "MOV-1", title: "Widget", url: "https://linear.app/moviecal/issue/MOV-1" };

function entryAt(headSha, overrides = {}) {
  return {
    id: "MOV-1",
    name: "MOV-1-widget",
    branch: BRANCH,
    path: "/worktrees/MOV-1-widget",
    status: "review",
    prNumber: 7,
    prUrl: "https://github.com/owner/repo/pull/7",
    worker: "claude",
    model: "default",
    headSha,
    provenance: { executor: "moviecal-dispatcher", repository: REPO },
    ...overrides,
  };
}

function observationAt(headSha, checks) {
  return observePullRequest({
    pr: {
      state: "OPEN",
      isDraft: true,
      url: "https://github.com/owner/repo/pull/7",
      headRefOid: headSha,
      headRefName: BRANCH,
      headRepository: { nameWithOwner: REPO },
    },
    checks,
    requiredChecks: checks.map((check) => check.name),
  });
}

const failing = (headSha) => observationAt(headSha, [
  { name: "lane-unit", conclusion: "FAILURE", sha: headSha },
  { name: "lane-baseline", conclusion: "SUCCESS", sha: headSha },
]);
const green = (headSha) => observationAt(headSha, [
  { name: "lane-unit", conclusion: "SUCCESS", sha: headSha },
  { name: "lane-baseline", conclusion: "SUCCESS", sha: headSha },
]);
const transient = (headSha) => observationAt(headSha, [
  { name: "lane-browser", conclusion: "TIMED_OUT", sha: headSha },
]);

function fakeLinearClient() {
  return {
    calls: [],
    moveToState: vi.fn(async function (issueId, stateId) {
      this.calls.push({ type: "moveToState", issueId, stateId });
    }),
    addComment: vi.fn(async function (issueId, body) {
      this.calls.push({ type: "addComment", issueId, body });
    }),
  };
}

/** A registry backed by a plain object, so `updateEntry` is really observable. */
function fakeWorktreeManager(entries) {
  const state = Object.fromEntries(entries.map((entry) => [entry.id, { ...entry }]));
  return {
    state,
    loadState: () => state,
    updateEntry(id, patch) {
      Object.assign(state[id], patch);
      return state[id];
    },
  };
}

function ctxFor({ ledger, observations, worktreeManager, linearClient, overrides = {} }) {
  const shift = () => (observations.length > 1 ? observations.shift() : observations[0]);
  return {
    linearClient,
    stateIds: STATE_IDS,
    worktreeManager,
    ledger,
    issuesByIdentifier: new Map([["MOV-1", ISSUE]]),
    ghRepo: REPO,
    logRoot: "/fake/logs",
    workerTimeoutMs: 60_000,
    observePrFn: shift,
    resolveHeadShaFn: () => worktreeManager.state["MOV-1"].headSha,
    spawnWorkerFn: vi.fn(async () => ({ exitCode: 0, logDir: "/fake/logs/x" })),
    auditWorkerResultFn: vi.fn(() => ({ ok: true, violations: [] })),
    writeWorkerAuditFn: vi.fn(() => ({ path: "/fake/logs/x/security-audit.json", sha256: "abc" })),
    publishRepairResultFn: vi.fn(() => ({ number: 7, url: "https://github.com/owner/repo/pull/7", headSha: "sha-2" })),
    rerunFailedChecksFn: vi.fn(() => ({ headSha: "sha-1", reran: [{ id: 999, name: "browser-verify" }] })),
    repairEvidenceFn: () => ({ ciLogs: "lane-unit failed" }),
    enabled: true,
    trustedReviewers: ["PelvicSorcerer"],
    logger: { error: vi.fn(), log: vi.fn() },
    ...overrides,
  };
}

describe("repairPass", () => {
  let tmpRoot;
  let ledger;
  let linearClient;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-repair-loop-test-"));
    ledger = new RepairLedger(path.join(tmpRoot, "repair-ledger.json"));
    linearClient = fakeLinearClient();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // The end-to-end shape MOV-151 exists to deliver: a failing PR is repaired
  // on its own branch, without a human dispatching anything, and the next
  // observation is green and does nothing further.
  it("repairs a failing PR on its existing branch and stops once the checks are green", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    const ctx = ctxFor({ ledger, worktreeManager, linearClient, observations: [failing("sha-1")] });

    const first = await repairPass(ctx);
    expect(first).toEqual([expect.objectContaining({ issue: "MOV-1", outcome: "repair-published", headSha: "sha-2" })]);

    // A repair worker, in repair mode, against the existing checkout.
    expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    const spawnArgs = ctx.spawnWorkerFn.mock.calls[0][0];
    expect(spawnArgs.securityContext).toEqual({ mode: "repair" });
    expect(spawnArgs.cwd).toBe("/worktrees/MOV-1-widget");
    expect(spawnArgs.brief).toMatch(/Repair MOV-1/);
    expect(spawnArgs.brief).toMatch(/lane-unit/);

    // Published onto the *same* PR, pinned to the SHA it was admitted against.
    expect(ctx.publishRepairResultFn).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH, repo: REPO, expectedHeadSha: "sha-1" }),
    );
    expect(worktreeManager.state["MOV-1"].headSha).toBe("sha-2");
    expect(ledger.previousAttempts("MOV-1", 7)).toMatchObject({ codeRepair: 1, total: 1 });

    // CI is now green on the new head: nothing further happens, and no
    // further budget is spent.
    const second = await repairPass(ctxFor({ ledger, worktreeManager, linearClient, observations: [green("sha-2")], overrides: { spawnWorkerFn: vi.fn() } }));
    expect(second).toEqual([expect.objectContaining({ outcome: "repair-skipped" })]);
    expect(ledger.previousAttempts("MOV-1", 7).total).toBe(1);
    expect(linearClient.calls.filter((call) => call.type === "moveToState")).toEqual([]);
  });

  it("re-runs a transient failure without starting a worker or touching a file", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    const ctx = ctxFor({ ledger, worktreeManager, linearClient, observations: [transient("sha-1")] });

    const results = await repairPass(ctx);

    expect(results[0].outcome).toBe("repair-reran");
    expect(ctx.rerunFailedChecksFn).toHaveBeenCalledWith({ repo: REPO, headSha: "sha-1" });
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    expect(ctx.publishRepairResultFn).not.toHaveBeenCalled();
    expect(ledger.previousAttempts("MOV-1", 7)).toMatchObject({ infrastructureRerun: 1, codeRepair: 0 });
  });

  it("does not repeat a repair for a failure it has already acted on", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    await repairPass(ctxFor({ ledger, worktreeManager, linearClient, observations: [failing("sha-1")] }));
    // The registry advanced to sha-2, but GitHub still reports the old head:
    // the dispatcher must not repair a SHA it has already repaired.
    worktreeManager.updateEntry("MOV-1", { headSha: "sha-1" });
    const again = ctxFor({ ledger, worktreeManager, linearClient, observations: [failing("sha-1")] });

    const results = await repairPass(again);

    expect(results[0]).toMatchObject({ outcome: "repair-skipped" });
    expect(again.spawnWorkerFn).not.toHaveBeenCalled();
  });

  it("escalates once, not on every poll cycle", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    const sensitive = observationAt("sha-1", [
      { name: "lane-review", conclusion: "FAILURE", sha: "sha-1", description: "sensitive-path change requires sign-off" },
    ]);

    const first = await repairPass(ctxFor({ ledger, worktreeManager, linearClient, observations: [sensitive] }));
    const second = await repairPass(ctxFor({ ledger, worktreeManager, linearClient, observations: [sensitive] }));

    expect(first[0].outcome).toBe("repair-escalated");
    expect(second[0].outcome).toBe("repair-escalation-already-reported");
    expect(linearClient.calls.filter((call) => call.type === "moveToState")).toEqual([
      { type: "moveToState", issueId: ISSUE.id, stateId: STATE_IDS.needsHumanDecision },
    ]);
    expect(linearClient.calls.filter((call) => call.type === "addComment")).toHaveLength(1);
  });

  it("refuses to publish a repair whose audit failed, and hands it to a human", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    const ctx = ctxFor({
      ledger,
      worktreeManager,
      linearClient,
      observations: [failing("sha-1")],
      overrides: {
        auditWorkerResultFn: vi.fn(() => ({ ok: false, violations: [{ action: "test/foo.test.ts", reason: "protected repair path changed" }] })),
      },
    });

    const results = await repairPass(ctx);

    expect(results[0]).toMatchObject({ outcome: "repair-failed" });
    expect(results[0].reason).toMatch(/protected repair path changed/);
    expect(ctx.publishRepairResultFn).not.toHaveBeenCalled();
    expect(ledger.find("MOV-1", ledger.attempts("MOV-1")[0].key)).toMatchObject({ outcome: "failed" });
  });

  it("records a repair worker's non-zero exit as a spent attempt rather than retrying it", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    const ctx = ctxFor({
      ledger,
      worktreeManager,
      linearClient,
      observations: [failing("sha-1")],
      overrides: { spawnWorkerFn: vi.fn(async () => ({ exitCode: 2, logDir: "/fake/logs/x" })) },
    });

    const results = await repairPass(ctx);

    expect(results[0]).toMatchObject({ outcome: "repair-failed" });
    expect(ctx.publishRepairResultFn).not.toHaveBeenCalled();
    expect(ledger.previousAttempts("MOV-1", 7).codeRepair).toBe(1);
  });

  it("skips a PR whose Linear issue is no longer in review", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    const ctx = ctxFor({
      ledger,
      worktreeManager,
      linearClient,
      observations: [failing("sha-1")],
      overrides: { issuesByIdentifier: new Map() },
    });

    expect(await repairPass(ctx)).toEqual([]);
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
  });

  it("skips a worktree that is not retained for review", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1", { status: "merged" })]);
    const ctx = ctxFor({ ledger, worktreeManager, linearClient, observations: [failing("sha-1")] });

    expect(await repairPass(ctx)).toEqual([]);
  });

  it("carries on with the other PRs when one cannot be observed", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    const ctx = ctxFor({
      ledger,
      worktreeManager,
      linearClient,
      observations: [failing("sha-1")],
      overrides: {
        observePrFn: () => {
          throw new Error("gh exploded");
        },
      },
    });

    expect(await repairPass(ctx)).toEqual([]);
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringMatching(/gh exploded/));
  });

  it("does nothing at all while the feature switch is off", async () => {
    const worktreeManager = fakeWorktreeManager([entryAt("sha-1")]);
    const ctx = ctxFor({ ledger, worktreeManager, linearClient, observations: [failing("sha-1")], overrides: { enabled: false } });

    const results = await repairPass(ctx);

    expect(results[0]).toMatchObject({ outcome: "repair-skipped" });
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    expect(linearClient.calls).toEqual([]);
    expect(ledger.attempts("MOV-1")).toEqual([]);
  });
});
