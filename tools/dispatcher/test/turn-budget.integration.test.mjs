import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce } from "../src/run-loop.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { buildUsageExport, captureWorkerUsage, WorkerUsageStore } from "../src/worker-usage.mjs";

const ISSUE = {
  id: "id-367", identifier: "MOV-367", title: "Budget fixture", description: "Fixture only.",
  url: "https://linear.app/moviecal/issue/MOV-367", labels: ["execution:mac"],
  delegate: { id: "dispatcher", name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" },
  blockedByIds: [],
};

describe("real-process turn budget continuation", () => {
  it("reaps the first process, retains its worktree, and publishes only after one fresh process succeeds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov367-integration-"));
    const checkout = path.join(root, "checkout");
    const logRoot = path.join(root, "logs");
    fs.mkdirSync(checkout);
    const fixture = path.join(root, "claude");
    fs.writeFileSync(fixture, `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const countPath = path.join(process.cwd(), "attempt-count");
let attempt = 0;
try { attempt = Number(fs.readFileSync(countPath, "utf8")); } catch {}
fs.writeFileSync(countPath, String(attempt + 1));
fs.writeFileSync(path.join(process.cwd(), "partial.txt"), "fixture work");
const limit = attempt === 0 ? 8 : 3;
for (let turn = 1; turn <= limit; turn++) {
  if (attempt === 0 && turn === 7) fs.writeFileSync(path.join(process.cwd(), "WORKER_PROGRESS.md"), "Done: partial work. Next: verify.");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", id: "m" + attempt + "-" + turn } }) + "\n");
}
if (attempt === 0) setInterval(() => {}, 1000);
else { process.stdout.write(JSON.stringify({ type: "result", num_turns: 3, duration_ms: 1000 }) + "\n"); process.exit(0); }
`, { mode: 0o755 });

    let entry;
    const worktreeManager = {
      activeCount: () => 0,
      isPathFreeForIssue: () => true,
      create: vi.fn((args) => {
        entry = { ...args, path: checkout, status: "active", provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" } };
        return entry;
      }),
      markStatus: vi.fn((_id, status) => { entry.status = status; }),
      loadState: () => ({ "MOV-367": entry }),
      isDispatcherOwnedWorktree: () => true,
      worktreeIntegrity: () => ({ intact: true, branch: entry.branch }),
      resumeEntry: vi.fn(() => { entry.status = "active"; return entry; }),
      prepareWorkerSpawn: () => {}, setWorkerPid: () => {},
    };
    const store = new WorkerUsageStore(path.join(root, "usage-state.json"));
    const linearClient = { moveToState: vi.fn(async () => {}), addComment: vi.fn(async () => {}) };
    const publishWorkerResultFn = vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true }));
    const spawnWorkerFn = vi.fn(({ securityContext: _securityContext, ...args }) => spawnWorker({
      ...args, invocation: { command: fixture, args: [] }, killGraceMs: 10,
    }));
    try {
      const [result] = await runOnce([ISSUE], {
        linearClient, worktreeManager, publishWorkerResultFn, spawnWorkerFn,
        stateIds: { agentWorking: "working", needsHumanDecision: "human", inReview: "review" },
        concurrencyLimit: 1, iosRunnerOnline: true, secretPresent: () => true,
        worktreeRoot: root, ghRepo: "owner/repo", logRoot, workerTimeoutMs: 10000,
        dispatcherDelegate: { id: "dispatcher", name: "moviecal-dispatcher" },
        refreshIssueFn: async () => ISSUE, turnBudgetFn: () => 8, steeringEnabled: true,
        repositoryContextFn: () => ({ changedPaths: [] }),
        diffSummaryFn: () => "partial.txt | 1 +",
        uncommittedChangesFn: () => ["partial.txt", "WORKER_PROGRESS.md"],
        auditWorkerResultFn: () => ({ ok: true, violations: [], actions: [] }),
        writeWorkerAuditFn: () => ({ path: "fixture-audit" }),
        captureVerificationEvidenceFn: () => ({ status: "passed" }),
        captureWorkerUsageFn: (logDir, context) => captureWorkerUsage(logDir, { ...context, origin: "dispatcher" }, { store }),
      });
      expect(result.outcome).toBe("in-review");
      expect(spawnWorkerFn).toHaveBeenCalledTimes(2);
      expect(worktreeManager.create).toHaveBeenCalledTimes(1);
      expect(worktreeManager.resumeEntry).toHaveBeenCalledTimes(1);
      expect(publishWorkerResultFn).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(checkout, "WORKER_PROGRESS.md"))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(logRoot, entry.name, "usage.json"), "utf8"))).toMatchObject({ turns: 8, partial: true });
      expect(JSON.parse(fs.readFileSync(path.join(logRoot, entry.name, "budget-continuation", "usage.json"), "utf8"))).toMatchObject({ turns: 3 });

      // MOV-382: both processes are separate, identifiable attempts in the
      // injected temporary ledger, and an issue total counts each once.
      const [first, second] = store.recent();
      expect(first).toMatchObject({ issue: "MOV-367", attemptKind: "implementation", terminationReason: "turn-budget", partial: true, origin: "dispatcher" });
      expect(second).toMatchObject({ issue: "MOV-367", attemptKind: "continuation", terminationReason: null, partial: false, origin: "dispatcher" });
      expect(first.attemptId).not.toBe(second.attemptId);
      const report = buildUsageExport(store.recent(), { issues: ["MOV-367"] });
      expect(report.selectedRuns).toBe(2);
      expect(report.byIssue[0]).toMatchObject({ attempts: 2, attemptsByKind: { implementation: 1, continuation: 1 } });
      expect(report.byIssue[0].byWorker[0].fields.turns).toEqual({ sum: 11, reported: 2, missing: 0 });
      expect(first).toMatchObject({ budgetUnit: "claude-assistant-turns" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 15000);
});

describe("real-process Codex item budget (MOV-387)", () => {
  const CODEX_ISSUE = { ...ISSUE, labels: ["execution:mac", "worker:codex"] };

  // `limits[n]` is how many completed command_execution items attempt n emits; attempts reaching the budget then hang.
  async function run(limits, budget) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov387-integration-"));
    const checkout = path.join(root, "checkout");
    const logRoot = path.join(root, "logs");
    fs.mkdirSync(checkout);
    const fixture = path.join(root, "codex");
    fs.writeFileSync(fixture, `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const countPath = path.join(process.cwd(), "attempt-count");
let attempt = 0;
try { attempt = Number(fs.readFileSync(countPath, "utf8")); } catch {}
fs.writeFileSync(countPath, String(attempt + 1));
fs.writeFileSync(path.join(process.cwd(), "partial.txt"), "fixture work");
const limits = ` + JSON.stringify(limits) + String.raw`;
const budget = ` + budget + String.raw`;
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
out({ type: "thread.started", thread_id: "t" });
out({ type: "turn.started" });
for (let i = 1; i <= limits[attempt]; i++) out({ type: "item.completed", item: { id: "i" + i, type: "command_execution", status: "completed" } });
if (limits[attempt] >= budget) setInterval(() => {}, 1000);
else { out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }); process.exit(0); }
`, { mode: 0o755 });

    let entry;
    const worktreeManager = {
      activeCount: () => 0,
      isPathFreeForIssue: () => true,
      create: vi.fn((args) => {
        entry = { ...args, path: checkout, status: "active", provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" } };
        return entry;
      }),
      markStatus: vi.fn((_id, status) => { entry.status = status; }),
      loadState: () => ({ "MOV-367": entry }),
      isDispatcherOwnedWorktree: () => true,
      worktreeIntegrity: () => ({ intact: true, branch: entry.branch }),
      resumeEntry: vi.fn(() => { entry.status = "active"; return entry; }),
      prepareWorkerSpawn: () => {}, setWorkerPid: () => {},
    };
    const store = new WorkerUsageStore(path.join(root, "usage-state.json"));
    const linearClient = { moveToState: vi.fn(async () => {}), addComment: vi.fn(async () => {}) };
    const publishWorkerResultFn = vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true }));
    const spawnWorkerFn = vi.fn(({ securityContext: _securityContext, ...args }) => spawnWorker({
      ...args, invocation: { command: fixture, args: [] }, killGraceMs: 10,
    }));
    const [result] = await runOnce([CODEX_ISSUE], {
      linearClient, worktreeManager, publishWorkerResultFn, spawnWorkerFn,
      stateIds: { agentWorking: "working", needsHumanDecision: "human", inReview: "review" },
      concurrencyLimit: 1, iosRunnerOnline: true, secretPresent: () => true,
      worktreeRoot: root, ghRepo: "owner/repo", logRoot, workerTimeoutMs: 10000,
      dispatcherDelegate: { id: "dispatcher", name: "moviecal-dispatcher" },
      refreshIssueFn: async () => CODEX_ISSUE, turnBudgetFn: () => budget, steeringEnabled: true,
      repositoryContextFn: () => ({ changedPaths: [] }),
      diffSummaryFn: () => "partial.txt | 1 +",
      uncommittedChangesFn: () => ["partial.txt"],
      auditWorkerResultFn: () => ({ ok: true, violations: [], actions: [] }),
      writeWorkerAuditFn: () => ({ path: "fixture-audit" }),
      captureVerificationEvidenceFn: () => ({ status: "passed" }),
      captureWorkerUsageFn: (logDir, context) => captureWorkerUsage(logDir, { ...context, origin: "dispatcher" }, { store }),
    });
    return { root, result, spawnWorkerFn, publishWorkerResultFn, linearClient, store, worktreeManager };
  }

  it("leaves a stream under the budget unaffected", async () => {
    const r = await run([3], 8);
    try {
      expect(r.result.outcome).toBe("in-review");
      expect(r.spawnWorkerFn).toHaveBeenCalledTimes(1);
      expect(r.publishWorkerResultFn).toHaveBeenCalledTimes(1);
      expect(r.store.recent()[0]).toMatchObject({ budgetUnit: "codex-items", budgetCount: 3, turns: 1 });
    } finally { fs.rmSync(r.root, { recursive: true, force: true }); }
  }, 15000);

  it("reaps at the budget, continues once without a wrap-up prompt, then publishes", async () => {
    const r = await run([8, 3], 8);
    try {
      expect(r.result.outcome).toBe("in-review");
      expect(r.spawnWorkerFn).toHaveBeenCalledTimes(2);
      expect(r.worktreeManager.resumeEntry).toHaveBeenCalledTimes(1);
      expect(r.spawnWorkerFn.mock.calls[1][0].brief).toContain("no progress file may exist");
      expect(r.publishWorkerResultFn).toHaveBeenCalledTimes(1);
      expect(r.store.recent()[0]).toMatchObject({ terminationReason: "turn-budget", budgetUnit: "codex-items", budgetCount: 8 });
    } finally { fs.rmSync(r.root, { recursive: true, force: true }); }
  }, 15000);

  it("hands off without publishing when the continuation also exhausts the budget", async () => {
    const r = await run([8, 8], 8);
    try {
      expect(r.result.outcome).toBe("budget-handoff");
      expect(r.spawnWorkerFn).toHaveBeenCalledTimes(2);
      expect(r.publishWorkerResultFn).not.toHaveBeenCalled();
    } finally { fs.rmSync(r.root, { recursive: true, force: true }); }
  }, 15000);
});
