import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observePullRequest } from "../src/pr-reconcile.mjs";
import { RepairLedger } from "../src/repair-ledger.mjs";
import { runRepairPass } from "../src/repair-run.mjs";

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
});
