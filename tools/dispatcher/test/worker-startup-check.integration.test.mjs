import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce } from "../src/run-loop.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { captureWorkerUsage, WorkerUsageStore } from "../src/worker-usage.mjs";
import { describeClaudeStartupCheck } from "../src/worker-startup-check.mjs";

const ISSUE = {
  id: "id-386", identifier: "MOV-386", title: "Startup check fixture", description: "Fixture only.",
  url: "https://linear.app/moviecal/issue/MOV-386", labels: ["execution:mac", "worker:claude"],
  delegate: { id: "dispatcher", name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" },
  blockedByIds: [],
};

describe("real-process Claude startup check (MOV-386)", () => {
  it("records and loudly warns about a mismatched init event while the run continues to publication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov386-integration-"));
    const checkout = path.join(root, "checkout");
    const logRoot = path.join(root, "logs");
    fs.mkdirSync(checkout);
    // Reproduces the observed Claude Code 2.1.281 behaviour: the scrub forced
    // the session to `default` and every built-in tool was loaded.
    const fixture = path.join(root, "claude");
    fs.writeFileSync(fixture, `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
emit({ type: "system", subtype: "init", permissionMode: "default", claude_code_version: "2.1.281",
  tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "NotebookEdit", "Task", "Workflow", "WebFetch"] });
fs.writeFileSync(path.join(process.cwd(), "change.txt"), "fixture work");
emit({ type: "assistant", message: { role: "assistant", id: "m1" } });
emit({ type: "result", subtype: "success", num_turns: 1, duration_ms: 10 });
process.exit(0);
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
      loadState: () => ({ "MOV-386": entry }),
      isDispatcherOwnedWorktree: () => true,
      worktreeIntegrity: () => ({ intact: true, branch: entry.branch }),
      prepareWorkerSpawn: () => {}, setWorkerPid: () => {},
    };
    const store = new WorkerUsageStore(path.join(root, "usage-state.json"));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const linearClient = { moveToState: vi.fn(async () => {}), addComment: vi.fn(async () => {}) };
    const publishWorkerResultFn = vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true }));
    const spawnWorkerFn = vi.fn(({ securityContext: _securityContext, ...args }) => spawnWorker({
      ...args, invocation: { command: fixture, args: [] }, killGraceMs: 10,
    }));
    try {
      const [result] = await runOnce([ISSUE], {
        linearClient, worktreeManager, publishWorkerResultFn, spawnWorkerFn, logger,
        stateIds: { agentWorking: "working", needsHumanDecision: "human", inReview: "review" },
        concurrencyLimit: 1, iosRunnerOnline: true, secretPresent: () => true,
        worktreeRoot: root, ghRepo: "owner/repo", logRoot, workerTimeoutMs: 10000,
        dispatcherDelegate: { id: "dispatcher", name: "moviecal-dispatcher" },
        refreshIssueFn: async () => ISSUE,
        repositoryContextFn: () => ({ changedPaths: [] }),
        uncommittedChangesFn: () => ["change.txt"],
        auditWorkerResultFn: () => ({ ok: true, violations: [], actions: [] }),
        writeWorkerAuditFn: () => ({ path: "fixture-audit" }),
        captureVerificationEvidenceFn: () => ({ status: "passed" }),
        captureWorkerUsageFn: (logDir, context) => captureWorkerUsage(logDir, { ...context, origin: "dispatcher" }, { store }),
      });

      // The run was not killed: it published exactly as a clean run would.
      expect(result.outcome).toBe("in-review");
      expect(publishWorkerResultFn).toHaveBeenCalledTimes(1);

      // Dispatcher log: one loud warning naming both problems.
      const warnings = logger.warn.mock.calls.map(([message]) => message).filter((message) => message.includes("MOV-386"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/Claude worker for MOV-386 did not start as configured — permissionMode is "default", expected "dontAsk"; tools outside the allowlist: Workflow, WebFetch/);

      // Usage record (ledger and the run's own usage.json).
      const [usage] = store.recent();
      expect(usage.startupCheck).toMatchObject({
        status: "mismatch", permissionMode: "default", unexpectedTools: ["Workflow", "WebFetch"], cliVersion: "2.1.281",
      });
      expect(JSON.parse(fs.readFileSync(path.join(logRoot, entry.name, "usage.json"), "utf8")).startupCheck.status).toBe("mismatch");

      // Doctor reads the same ledger.
      expect(describeClaudeStartupCheck(store.recent())).toMatchObject({ ok: false, detail: expect.stringMatching(/^MISMATCH — .*Last observed MOV-386 .*Claude Code 2\.1\.281: mode default/) });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 15000);
});
