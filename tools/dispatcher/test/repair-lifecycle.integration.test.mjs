import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observePullRequest } from "../src/pr-reconcile.mjs";
import { RepairLedger } from "../src/repair-ledger.mjs";
import { runRepairPass } from "../src/repair-run.mjs";

const REPO = "owner/repo";
const HEAD = "head-1";
const roots = [];

function entry() {
  return { id: "MOV-1", linearIssueId: "linear-1", name: "MOV-1-repair", branch: "agent/MOV-1-repair", path: "/worktrees/MOV-1-repair", status: "review", prNumber: 1, prUrl: "https://github.com/owner/repo/pull/1", worker: "codex", model: "default", provenance: { executor: "moviecal-dispatcher", repository: REPO } };
}

function observed({ name = "lane-unit", conclusion = "FAILURE", review = null, description = null } = {}) {
  return observePullRequest({
    pr: { state: "OPEN", isDraft: true, url: "https://github.com/owner/repo/pull/1", headRefOid: HEAD, headRefName: "agent/MOV-1-repair", headRepository: { nameWithOwner: REPO }, reviewDecision: review ? "CHANGES_REQUESTED" : null },
    checks: [{ name, conclusion, description }],
    requiredChecks: [name],
    reviews: review ? [{ state: "REQUEST_CHANGES", author: { login: review }, body: "Please repair this." }] : [],
  });
}

function context({ observation = observed(), ledgerPath = null } = {}) {
  const root = ledgerPath ? path.dirname(ledgerPath) : fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-repair-lifecycle-"));
  if (!ledgerPath) roots.push(root);
  const target = entry();
  const ctx = {
    enabled: true, lockHeldFn: () => true, ledger: new RepairLedger(ledgerPath || path.join(root, "ledger.json")),
    worktreeManager: { loadState: () => ({ "MOV-1": target }), activeCount: () => 0, updateEntry: vi.fn() },
    ghRepo: REPO, logRoot: root, workerTimeoutMs: 1_000, budgets: { codeRepair: 2, infrastructureRerun: 1, total: 3 }, concurrencyLimit: 1, trustedReviewers: ["trusted"],
    observePrFn: vi.fn(() => observation), localHeadShaFn: () => HEAD, uncommittedChangesFn: () => [], issueForEntryFn: async () => ({ id: "linear-1", identifier: "MOV-1", title: "Repair", description: "" }),
    spawnWorkerFn: vi.fn(async () => ({ exitCode: 0 })), workerInvocationFn: () => ({ command: "worker", args: [] }), auditWorkerResultFn: () => ({ ok: true, violations: [] }), writeWorkerAuditFn: () => ({}),
    publishRepairResultFn: vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", headSha: "head-2" })), rerunFailedJobsFn: vi.fn(() => ({ rerun: [{ id: 4, name: "CI", conclusion: "timed_out" }], skipped: [], errors: [] })), collectRepairEvidenceFn: () => ({}), commentOnPullRequestFn: vi.fn(), stateIds: { needsHumanDecision: "human" }, logger: { error() {} },
  };
  return ctx;
}

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("bounded repair lifecycle seam (MOV-191)", () => {
  it("publishes one code repair and a restarted dispatcher never repeats that reserved fingerprint", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-repair-restart-"));
    roots.push(root);
    const ledgerPath = path.join(root, "ledger.json");
    const first = context({ ledgerPath });
    expect((await runRepairPass(first))[0].outcome).toBe("repaired");
    const restarted = context({ ledgerPath });
    expect((await runRepairPass(restarted))[0]).toMatchObject({ outcome: "ignored" });
    expect(restarted.spawnWorkerFn).not.toHaveBeenCalled();
  });

  it("runs a trusted review repair and an infrastructure rerun through their distinct lifecycle actions", async () => {
    const review = context({ observation: observed({ name: "lane-baseline", conclusion: "SUCCESS", review: "trusted" }) });
    expect((await runRepairPass(review))[0].outcome).toBe("repaired");
    expect(review.spawnWorkerFn).toHaveBeenCalledTimes(1);
    const transient = context({ observation: observed({ name: "lane-browser", conclusion: "TIMED_OUT" }) });
    expect((await runRepairPass(transient))[0]).toMatchObject({ outcome: "rerun", reran: 1 });
    expect(transient.spawnWorkerFn).not.toHaveBeenCalled();
  });

  it("records one idempotent human escalation for a sensitive review finding", async () => {
    const ctx = context({ observation: observed({ name: "lane-review", description: "secret-shaped string detected" }) });
    expect((await runRepairPass(ctx))[0].outcome).toBe("escalated");
    expect((await runRepairPass(ctx))[0].outcome).toBe("stop-already-published");
    expect(ctx.commentOnPullRequestFn).toHaveBeenCalledTimes(1);
  });
});
