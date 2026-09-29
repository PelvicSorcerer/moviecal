import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observePullRequest } from "../src/pr-reconcile.mjs";
import { RepairLedger } from "../src/repair-ledger.mjs";
import { previewRepairPass, runRepairPass } from "../src/repair-run.mjs";
import { captureWorkerUsage, WorkerUsageStore } from "../src/worker-usage.mjs";
import { CLAUDE_WORKER_TOOLS, workerInvocation } from "../src/worker-routing.mjs";
import { CODEX_SINGLE_TURN } from "./usage-fixtures.mjs";

const REPO = "owner/repo";
const HEAD = "abc123";
const ENTRY = {
  id: "MOV-190",
  linearIssueId: "linear-190",
  name: "MOV-190-repair",
  branch: "agent/MOV-190-repair",
  path: "/worktrees/MOV-190-repair",
  status: "review",
  prNumber: 190,
  prUrl: "https://github.com/owner/repo/pull/190",
  worker: "codex",
  model: "default",
  headSha: HEAD,
  provenance: { executor: "moviecal-dispatcher", repository: REPO },
};

const issue = { id: "linear-190", identifier: "MOV-190", title: "Repair CI", description: "Repair the failing lane." };
const tmpRoots = [];

function observation({ conclusion = "FAILURE", name = "lane-unit" } = {}) {
  return observePullRequest({
    pr: {
      state: "OPEN",
      isDraft: true,
      url: ENTRY.prUrl,
      headRefOid: HEAD,
      headRefName: ENTRY.branch,
      headRepository: { nameWithOwner: REPO },
    },
    checks: [{ name, conclusion, workflowName: name, detailsUrl: "https://ci/example" }],
    requiredChecks: [name],
  });
}

function context({ entry = ENTRY, observed = observation(), dirty = [], enabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-repair-run-test-"));
  tmpRoots.push(root);
  const manager = {
    loadState: () => ({ [entry.id]: entry }),
    activeCount: () => 0,
    updateEntry: vi.fn(),
  };
  return {
    enabled,
    lockHeldFn: vi.fn(() => true),
    ledger: new RepairLedger(path.join(root, "repair-ledger.json")),
    worktreeManager: manager,
    ghRepo: REPO,
    logRoot: root,
    workerTimeoutMs: 1_000,
    budgets: { codeRepair: 2, infrastructureRerun: 1, total: 3 },
    concurrencyLimit: 1,
    trustedReviewers: [],
    observePrFn: vi.fn(() => observed),
    localHeadShaFn: vi.fn(() => HEAD),
    uncommittedChangesFn: vi.fn(() => dirty),
    issueForEntryFn: vi.fn(async () => issue),
    spawnWorkerFn: vi.fn(async () => ({ exitCode: 0 })),
    prepareDependenciesFn: vi.fn(async () => ({ ok: true, status: "already-prepared" })),
    workerInvocationFn: vi.fn(() => ({ command: "worker", args: [] })),
    auditWorkerResultFn: vi.fn(() => ({ ok: true, violations: [] })),
    writeWorkerAuditFn: vi.fn(() => ({ path: "/logs/audit.json", sha256: "digest" })),
    publishRepairResultFn: vi.fn(() => ({ number: ENTRY.prNumber, url: ENTRY.prUrl, headSha: "def456" })),
    rerunFailedJobsFn: vi.fn(() => ({ rerun: [], skipped: [], errors: [] })),
    collectRepairEvidenceFn: vi.fn(() => ({ ciLogs: "failure", prBody: "", diff: "", reviewComments: "" })),
    commentOnPullRequestFn: vi.fn(),
    stateIds: { needsHumanDecision: "human" },
    logger: { error: vi.fn() },
  };
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("runRepairPass (MOV-190)", () => {
  it("runs, audits, and publishes one admitted code repair on the existing PR branch", async () => {
    const ctx = context();

    const [result] = await runRepairPass(ctx);

    expect(result).toMatchObject({ issue: ENTRY.id, outcome: "repaired", pr: ENTRY.prUrl, headSha: "def456" });
    expect(ctx.spawnWorkerFn).toHaveBeenCalledWith(expect.objectContaining({ cwd: ENTRY.path, securityContext: { mode: "repair" } }));
    expect(ctx.auditWorkerResultFn).toHaveBeenCalledWith(expect.objectContaining({ mode: "repair", baseRef: HEAD }));
    expect(ctx.publishRepairResultFn).toHaveBeenCalledWith(expect.objectContaining({ branch: ENTRY.branch, expectedHeadSha: HEAD, issue }));
    expect(ctx.ledger.previousAttempts(ENTRY.id, ENTRY.prNumber)).toMatchObject({ codeRepair: 1, total: 1 });
    expect(ctx.worktreeManager.updateEntry).toHaveBeenCalledWith(ENTRY.id, { headSha: "def456" });
  });

  it("captures the repair attempt's usage into an injected temporary store with model and effort (MOV-382)", async () => {
    const ctx = context();
    const store = new WorkerUsageStore(path.join(ctx.logRoot, "usage-state.json"));
    ctx.workerInvocationFn = vi.fn(() => ({ command: "codex", args: ["exec", "-c", "model_reasoning_effort=medium", "--model", "gpt-6-sol"] }));
    ctx.spawnWorkerFn = vi.fn(async ({ logDir }) => {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), CODEX_SINGLE_TURN);
      return { exitCode: 0 };
    });
    ctx.captureWorkerUsageFn = (logDir, context) => captureWorkerUsage(logDir, { ...context, origin: "dispatcher" }, { store });

    const [result] = await runRepairPass(ctx);

    expect(result.outcome).toBe("repaired");
    const [usage] = store.recent();
    expect(store.recent()).toHaveLength(1);
    expect(usage).toMatchObject({
      issue: ENTRY.id, attemptKind: "repair", worker: "codex", tier: "default", modelId: "gpt-6-sol", reasoningEffort: "medium",
      inputTokens: 24763, cacheReadTokens: 24448, outputTokens: 122, costUsd: null, exitOutcome: "exited-0", origin: "dispatcher",
    });
    expect(usage.attemptId).toEqual(expect.any(String));
  });

  it("gives a Claude repair worker the explicit tool set and warns on a mismatched init event without stopping (MOV-386)", async () => {
    const ctx = context({ entry: { ...ENTRY, worker: "claude" } });
    ctx.workerInvocationFn = workerInvocation;
    ctx.logger = { error: vi.fn(), warn: vi.fn() };
    ctx.spawnWorkerFn = vi.fn(async ({ onWorkerInit }) => {
      onWorkerInit({ type: "system", subtype: "init", permissionMode: "acceptEdits", tools: [...CLAUDE_WORKER_TOOLS, "Workflow"] });
      return { exitCode: 0 };
    });

    const [result] = await runRepairPass(ctx);

    expect(result.outcome).toBe("repaired");
    const { invocation } = ctx.spawnWorkerFn.mock.calls[0][0];
    expect(invocation.args.slice(invocation.args.indexOf("--permission-mode"), invocation.args.indexOf("--permission-mode") + 8)).toEqual([
      "--permission-mode", "default", "--permission-prompts", "none", "--tools", CLAUDE_WORKER_TOOLS.join(","), "--allowedTools", CLAUDE_WORKER_TOOLS.join(","),
    ]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Claude worker for MOV-190 repair did not start as configured — permissionMode is "acceptEdits".*tools outside the allowlist: Workflow/));
  });

  it("does not attach the Claude startup check to a Codex repair worker (MOV-386)", async () => {
    const ctx = context();
    await runRepairPass(ctx);
    expect(ctx.spawnWorkerFn.mock.calls[0][0]).not.toHaveProperty("onWorkerInit");
  });

  it("re-runs an admitted transient failure without starting a worker or publishing code", async () => {
    const ctx = context({ observed: observation({ name: "lane-browser", conclusion: "TIMED_OUT" }) });
    ctx.rerunFailedJobsFn.mockReturnValue({ rerun: [{ id: 9, name: "browser", conclusion: "timed_out" }], skipped: [], errors: [] });

    const [result] = await runRepairPass(ctx);

    expect(result).toMatchObject({ outcome: "rerun", reran: 1 });
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    expect(ctx.publishRepairResultFn).not.toHaveBeenCalled();
    expect(ctx.rerunFailedJobsFn).toHaveBeenCalledWith(expect.objectContaining({ headSha: HEAD, prNumber: ENTRY.prNumber }));
  });

  it("refuses a dirty retained checkout and durably reports that stop only once", async () => {
    const ctx = context({ dirty: ["src/unpublished.ts"] });

    const [first] = await runRepairPass(ctx);
    const [second] = await runRepairPass(ctx);

    expect(first).toMatchObject({ outcome: "refused" });
    expect(second).toMatchObject({ outcome: "stop-already-published" });
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    expect(ctx.commentOnPullRequestFn).toHaveBeenCalledTimes(1);
    expect(ctx.ledger.previousAttempts(ENTRY.id, ENTRY.prNumber).total).toBe(0);
  });

  it("does nothing at all while automatic repair is switched off", async () => {
    const ctx = context({ enabled: false });
    await expect(runRepairPass(ctx)).resolves.toEqual([]);
    expect(ctx.observePrFn).not.toHaveBeenCalled();
  });

  it("requires the dispatcher singleton lock before any live repair observation", async () => {
    const ctx = context();
    ctx.lockHeldFn.mockReturnValue(false);

    await expect(runRepairPass(ctx)).rejects.toThrow(/singleton lock/);
    expect(ctx.observePrFn).not.toHaveBeenCalled();
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
  });

  it("previews live admission without reserving, spawning, reporting, or publishing", async () => {
    const ctx = context();
    ctx.lockHeldFn.mockReturnValue(false);

    const [preview] = await previewRepairPass(ctx);

    expect(preview).toMatchObject({ issue: ENTRY.id, action: "code-repair", headSha: HEAD });
    expect(ctx.ledger.attempts(ENTRY.id)).toEqual([]);
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    expect(ctx.publishRepairResultFn).not.toHaveBeenCalled();
    expect(ctx.commentOnPullRequestFn).not.toHaveBeenCalled();
    expect(ctx.issueForEntryFn).not.toHaveBeenCalled();
  });
});

describe("trusted dependency install before a repair worker (MOV-410)", () => {
  it("installs before spawning the repair worker and records the install in its manifest arguments", async () => {
    const ctx = context();
    const order = [];
    const record = { ok: true, status: "installed", command: "npm", args: ["ci", "--ignore-scripts"], exitCode: 0 };
    ctx.prepareDependenciesFn = vi.fn(async () => { order.push("install"); return record; });
    ctx.spawnWorkerFn = vi.fn(async () => { order.push("spawn"); return { exitCode: 0 }; });

    const [result] = await runRepairPass(ctx);

    expect(result.outcome).toBe("repaired");
    expect(order).toEqual(["install", "spawn"]);
    expect(ctx.prepareDependenciesFn).toHaveBeenCalledWith({ worktreePath: ENTRY.path, logDir: path.join(ctx.logRoot, `${ENTRY.name}-repair-${HEAD}`) });
    expect(ctx.spawnWorkerFn).toHaveBeenCalledWith(expect.objectContaining({ dependencyInstall: record, securityContext: { mode: "repair" } }));
  });

  it("closes the reserved attempt without a worker when the install fails", async () => {
    const ctx = context();
    ctx.prepareDependenciesFn = vi.fn(async () => ({ ok: false, status: "failed", reason: "npm ci --ignore-scripts exited with code 1", outputTail: "npm error code ENOTFOUND" }));

    const [result] = await runRepairPass(ctx);

    expect(result.outcome).toBe("repair-failed");
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    expect(ctx.publishRepairResultFn).not.toHaveBeenCalled();
    const [attempt] = ctx.ledger.attempts(ENTRY.id);
    expect(attempt).toMatchObject({ outcome: "failed" });
    expect(attempt.detail).toMatch(/could not prepare dependencies before the repair worker: npm ci --ignore-scripts exited with code 1/);
    const comment = ctx.commentOnPullRequestFn.mock.calls.at(-1)[0].body;
    expect(comment).toContain("npm error code ENOTFOUND");
    expect(comment).toMatch(/No worker was started/);
    expect(comment).not.toMatch(/repair worker's changes were \*\*not\*\* published/);
    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.logRoot, `${ENTRY.name}-repair-${HEAD}`, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ workerStarted: false, dependencyInstall: { status: "failed" } });
  });

  it("refuses to run without the install step wired", async () => {
    const ctx = context();
    delete ctx.prepareDependenciesFn;
    await expect(runRepairPass(ctx)).rejects.toThrow(/missing required dependencies: prepareDependenciesFn/);
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
  });
});
