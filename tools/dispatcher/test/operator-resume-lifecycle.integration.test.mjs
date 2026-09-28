import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeManager } from "../src/worktree-manager.mjs";
import { inspectOperatorResume } from "../src/operator-resume.mjs";
import { runOperatorResume } from "../src/run-loop.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { auditWorkerResult, writeWorkerAudit } from "../src/worker-guard.mjs";
import { captureVerificationEvidence } from "../src/readiness-evidence.mjs";
import { publishWorkerResult } from "../src/worker-publish.mjs";
import { CircuitBreakerStore } from "../src/circuit-breaker.mjs";
import { UsageLimitStore } from "../src/usage-limit.mjs";
import { WorkerCooldownStore } from "../src/worker-cooldown.mjs";

const suite = process.env.MOVIECAL_WORKER_SANDBOX ? describe.skip : describe;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const NOW = new Date("2026-09-28T04:00:00Z");

function fixture() {
  // Seatbelt and Git both resolve /var through /private/var on macOS.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-resume-lifecycle-")));
  roots.push(root);
  const main = path.join(root, "main");
  const remote = path.join(root, "remote.git");
  const worktreeRoot = path.join(root, "worktrees");
  fs.mkdirSync(main);
  fs.mkdirSync(worktreeRoot);
  const git = (args, cwd = main) => String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
  git(["init", "--bare", remote]);
  git(["init", "-b", "master"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(main, "README.md"), "base\n");
  fs.writeFileSync(path.join(main, "package.json"), JSON.stringify({ scripts: { verify: "node verify.cjs" } }));
  fs.writeFileSync(path.join(main, "verify.cjs"), `const fs = require("node:fs");
for (const [file, expected] of [["README.md", "staged\\n"], ["untracked.txt", "untracked\\n"], ["committed.txt", "unpublished\\n"]]) {
  if (fs.readFileSync(file, "utf8") !== expected) throw new Error("lost retained work: " + file);
}
console.log("retained fixture verification passed");\n`);
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-u", "origin", "master"]);
  const issue = {
    id: "fixture-uuid", identifier: "MOV-123", title: "Retained fixture", stateName: "Needs Human Decision",
    url: "https://linear.app/moviecal/issue/MOV-123/fixture",
    description: "## Acceptance criteria\n- Preserve and finish.\n## Testing Expectations\nUnit and integration.\n## Manual Verification\nHuman testing: required\nAutonomy: disabled",
    labels: ["execution:mac", "worker:codex", "model:strong", "upgrade:security-critical"],
    delegate: { name: "moviecal-dispatcher" }, blockedByIds: [], inverseRelations: [],
    recentComments: ["Worker timed out after 2700000ms and was killed."],
  };
  const manager = new WorktreeManager({ repoRoot: main, worktreeRoot, statePath: path.join(root, "state.json"),
    trustWorkspaceFn: () => ({ ok: true }) });
  const entry = manager.create({ id: issue.identifier, name: "MOV-123-fixture", branch: "agent/MOV-123-fixture",
    worker: "codex", model: "strong", linearUrl: issue.url, linearIssueId: issue.id, repository: "PelvicSorcerer/moviecal" });
  fs.writeFileSync(path.join(entry.path, "committed.txt"), "unpublished\n");
  git(["add", "committed.txt"], entry.path);
  git(["commit", "-m", "retained partial work"], entry.path);
  fs.writeFileSync(path.join(entry.path, "README.md"), "staged\n");
  git(["add", "README.md"], entry.path);
  fs.writeFileSync(path.join(entry.path, "untracked.txt"), "untracked\n");
  manager.setWorkerPid(issue.identifier, 2147483000); // Retain an exited historical worker PID.
  manager.markStatus(issue.identifier, "failed");
  const linearClient = { moveToState: vi.fn(async () => {}), addComment: vi.fn(async () => {}) };
  const ctx = {
    worktreeManager: manager, worktreeRoot, logRoot: path.join(root, "logs"), ghRepo: "PelvicSorcerer/moviecal",
    dispatcherDelegate: { name: "moviecal-dispatcher" }, iosRunnerOnline: true, concurrencyLimit: 1,
    secretPresent: () => true, issueSpecMode: "off", steeringEnabled: false,
    circuitBreaker: new CircuitBreakerStore(path.join(root, "breakers.json")),
    usageLimitStore: new UsageLimitStore(path.join(root, "limits.json")),
    workerCooldownStore: new WorkerCooldownStore(path.join(root, "cooldowns.json")),
    lockHeldFn: () => true, linearClient,
    stateIds: { agentWorking: "working", needsHumanDecision: "human", inReview: "review" },
    repositoryContextFn: () => null, refreshIssueFn: async () => issue,
    stopPollIntervalMs: 0, workerTimeoutMs: 10000, now: () => NOW, logger: console,
    auditWorkerResultFn: auditWorkerResult, writeWorkerAuditFn: writeWorkerAudit,
    captureVerificationEvidenceFn: captureVerificationEvidence,
    applyStagedWorkflowEditFn: () => ({ applied: false }),
    publishWorkerResultFn: vi.fn(() => { throw new Error("unexpected publication"); }),
  };
  const inspection = inspectOperatorResume(issue, ctx, { findPrFn: () => null });
  expect(inspection.admitted).toBe(true);
  return { root, remote, git, issue, entry, manager, ctx, inspection };
}

suite("operator continuation lifecycle", () => {
  it("previews retained staged, untracked and committed work without changing Git or state", () => {
    const f = fixture();
    const indexPath = f.git(["rev-parse", "--path-format=absolute", "--git-path", "index"], f.entry.path);
    const before = {
      state: fs.readFileSync(f.manager.statePath), index: fs.readFileSync(indexPath),
      head: f.git(["rev-parse", "HEAD"], f.entry.path),
    };
    const preview = inspectOperatorResume(f.issue, f.ctx, { findPrFn: () => null });
    expect(preview.admitted).toBe(true);
    expect(preview.changedPaths).toEqual(["README.md", "untracked.txt"]);
    expect(preview.unpublishedCommits).toBe(1);
    expect(fs.readFileSync(f.manager.statePath).equals(before.state)).toBe(true);
    expect(fs.readFileSync(indexPath).equals(before.index)).toBe(true);
    expect(f.git(["rev-parse", "HEAD"], f.entry.path)).toBe(before.head);
    expect(fs.readFileSync(path.join(f.entry.path, "untracked.txt"), "utf8")).toBe("untracked\n");
  });
  it.runIf(process.platform === "darwin")("uses the real macOS guard, captures verification, and publishes preserved work once", async () => {
    const f = fixture();
    const source = String.raw`
const { execFileSync } = require("node:child_process");
console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture" }));
const output = execFileSync("npm", ["run", "verify"], { cwd: process.cwd(), encoding: "utf8" });
console.log(JSON.stringify({ type: "item.completed", item: { id: "verify", type: "command_execution", command: "npm run verify", status: "completed", exit_code: 0, aggregated_output: output } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`;
    f.ctx.spawnWorkerFn = vi.fn((args) => spawnWorker({ ...args, invocation: { command: process.execPath, args: ["-e", source] } }));
    let created = false;
    const runner = (command, args, options) => {
      if (command === "gh") {
        if (args[1] === "list") return created ? JSON.stringify([{ number: 7, url: "https://github.example/pr/7", isDraft: true }]) : "[]";
        if (args[1] === "create") { created = true; return ""; }
        throw new Error("unexpected GitHub mutation");
      }
      return execFileSync(command, args, { encoding: "utf8", ...options });
    };
    f.ctx.publishWorkerResultFn = vi.fn((args) => {
      expect(args.verificationEvidence.status).toBe("passed");
      return publishWorkerResult({ ...args, runner });
    });
    const result = await runOperatorResume(f.issue, f.inspection, f.ctx);
    const attemptLog = f.manager.loadState()[f.issue.identifier].operatorResume.logDir;
    expect(result.outcome, JSON.stringify(result) + fs.readFileSync(path.join(attemptLog, "stderr.log"), "utf8")).toBe("in-review");
    expect(f.ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    expect(f.ctx.publishWorkerResultFn).toHaveBeenCalledTimes(1);
    const current = f.manager.loadState()[f.issue.identifier];
    expect(current.operatorResume).toMatchObject({ status: "finished", outcome: "in-review", stage: "publication-returned" });
    expect(current.operatorResumeHistory).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(current.operatorResume.logDir, "manifest.json"), "utf8")).securityGuard.enforced).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(current.operatorResume.logDir, "verification-evidence.json"), "utf8")).status).toBe("passed");
    expect(f.git(["rev-parse", `refs/heads/${f.entry.branch}`], f.remote)).toBe(f.git(["rev-parse", "HEAD"], f.entry.path));
    for (const [file, text] of [["README.md", "staged\n"], ["untracked.txt", "untracked\n"], ["committed.txt", "unpublished\n"]]) {
      expect(fs.readFileSync(path.join(f.entry.path, file), "utf8")).toBe(text);
    }
    await expect(runOperatorResume(f.issue, f.inspection, f.ctx)).rejects.toThrow(/target changed/);
    if (process.env.MOVIECAL_OPERATOR_RESUME_ARTIFACT_ROOT) {
      const destination = path.resolve(process.env.MOVIECAL_OPERATOR_RESUME_ARTIFACT_ROOT);
      fs.cpSync(current.operatorResume.logDir, destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "fixture-result.json"), JSON.stringify({ result, attempt: current.operatorResume,
        preserved: true, originalBranch: f.entry.branch, fakeGitHub: true }, null, 2));
    }
  }, 20000);

  it.each([
    ["sandbox", 71, "sandbox-exec: sandbox_apply: Operation not permitted", "nested-sandbox-crash"],
    ["credential", 1, "authentication_failed: invalid API key (401)", "credential-failure"],
    ["quota", 1, "usage limit reached; resets 2026-09-28T06:00:00Z", null],
    ["unknown quota", 1, "usage limit reached; resets soon", null],
  ])("records %s gates without retrying a spent continuation", async (_name, exitCode, message, breaker) => {
    const f = fixture();
    f.ctx.spawnWorkerFn = vi.fn(async ({ logDir }) => {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), JSON.stringify({ type: "thread.started", thread_id: "fixture" }) + "\n");
      fs.writeFileSync(path.join(logDir, "stderr.log"), message);
      return { exitCode, logDir };
    });
    const result = await runOperatorResume(f.issue, f.inspection, f.ctx);
    expect(result.outcome, JSON.stringify(result)).toBe("operator-resume-failed");
    expect(f.ctx.publishWorkerResultFn).not.toHaveBeenCalled();
    expect(f.ctx.linearClient.moveToState).toHaveBeenLastCalledWith(f.issue.id, "human");
    const current = f.manager.loadState()[f.issue.identifier];
    expect(current.status).toBe("failed");
    expect(current.operatorResume.outcome).toBe("operator-resume-failed");
    if (breaker) expect(f.ctx.circuitBreaker.status(breaker).open).toBe(true);
    if (_name === "quota") expect(f.ctx.workerCooldownStore.state("codex", NOW).cooling).toBe(true);
    if (_name.includes("quota")) expect(f.ctx.usageLimitStore.deferral(f.issue.identifier, NOW).deferred).toBe(false);
    await expect(runOperatorResume(f.issue, f.inspection, f.ctx)).rejects.toThrow(/target changed/);
  });

  it("retains work on timeout and refuses a replay", async () => {
    const f = fixture();
    f.ctx.workerTimeoutMs = 10;
    f.ctx.spawnWorkerFn = vi.fn(({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ exitCode: 143 }), { once: true });
    }));
    const result = await runOperatorResume(f.issue, f.inspection, f.ctx);
    expect(result.outcome).toBe("timeout");
    expect(f.ctx.publishWorkerResultFn).not.toHaveBeenCalled();
    expect(f.manager.loadState()[f.issue.identifier].operatorResume).toMatchObject({ status: "finished", stage: "timed-out" });
    expect(fs.readFileSync(path.join(f.entry.path, "untracked.txt"), "utf8")).toBe("untracked\n");
    await expect(runOperatorResume(f.issue, f.inspection, f.ctx)).rejects.toThrow(/target changed/);
  });
});
