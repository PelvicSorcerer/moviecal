import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOnce } from "../src/run-loop.mjs";
import { runRepairPass } from "../src/repair-run.mjs";
import { RepairLedger } from "../src/repair-ledger.mjs";
import { observePullRequest } from "../src/pr-reconcile.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { auditWorkerResult, extractToolActions, isInsideWorkerSandboxEnv, writeWorkerAudit } from "../src/worker-guard.mjs";
import { captureVerificationEvidence } from "../src/readiness-evidence.mjs";
import { INSTALL_ARGS, INSTALL_MARKER, prepareWorktreeDependencies } from "../src/dependency-install.mjs";

// MOV-410: the real run loop, the real spawnWorker(), the real install step,
// the real transcript audit and verification-evidence capture. Only `npm` and
// Git are simulated: a fake npm records how the dispatcher ran it, and a fake
// Git runner answers from the fixture checkout, so this also runs inside a
// worker's own sandboxed `npm run verify`.

const LOCKFILE = '{"name":"fixture","lockfileVersion":3,"packages":{}}\n';
const LOCK_SHA = createHash("sha256").update(LOCKFILE).digest("hex");
const HEAD = "4100000000000000000000000000000000000410";
const BINS = ["tsc", "next", "vitest"];
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function issueFor(worker) {
  return {
    id: `id-410-${worker}`, identifier: "MOV-410", title: "Dependency install fixture", description: "Fixture only.",
    url: "https://linear.app/moviecal/issue/MOV-410", labels: ["execution:mac", `worker:${worker}`], project: null,
    delegate: { id: "dispatcher", name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" },
    blockedByIds: [],
  };
}

// `mode`: "install" creates the toolchain; "fail" is MOV-331's offline npm.
function writeFakeNpm(file, callsFile, mode) {
  fs.writeFileSync(file, `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), at: Date.now(),
  sandboxMarker: process.env.MOVIECAL_WORKER_SANDBOX ?? null,
  credentialKeys: Object.keys(process.env).filter((key) => /TOKEN|SECRET|API_KEY/.test(key)),
}) + "\n");
if (${JSON.stringify(mode)} === "fail") {
  process.stderr.write("npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/next failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n");
  process.exit(1);
}
fs.rmSync("node_modules", { recursive: true, force: true });
fs.mkdirSync("node_modules/.bin", { recursive: true });
for (const bin of ${JSON.stringify(BINS)}) fs.writeFileSync(path.join("node_modules/.bin", bin), "#!/bin/sh\n", { mode: 0o755 });
process.stdout.write("added 3 packages in 0s\n");
`, { mode: 0o755 });
}

// A Claude-shaped fixture worker: runs each Bash command and reports it.
function writeFixtureWorker(file, startedFile, commands) {
  fs.writeFileSync(file, `#!${process.execPath}\n` + String.raw`
const { execSync } = require("node:child_process");
require("node:fs").appendFileSync(${JSON.stringify(startedFile)}, JSON.stringify({ at: Date.now() }) + "\n");
const commands = ${JSON.stringify(commands)};
commands.forEach((command, index) => {
  const id = "tool-" + index;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", id: "m" + index, content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }) + "\n");
  const output = execSync(command, { cwd: process.cwd(), shell: "/bin/sh", encoding: "utf8" });
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } }) + "\n");
});
process.stdout.write(JSON.stringify({ type: "result", num_turns: commands.length, duration_ms: 10 }) + "\n");
`, { mode: 0o755 });
}

// The worker proves the toolchain existed before it started, then makes one change.
const WORKER_COMMANDS = [
  "test -x node_modules/.bin/vitest && test -x node_modules/.bin/tsc && test -x node_modules/.bin/next && echo toolchain-ready",
  "mkdir -p src && echo 'export const x = 1;' > src/feature.ts",
];

function makeFixture({ npmMode = "install", partial = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov410-integration-"));
  roots.push(root);
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, "package.json"), '{"name":"fixture","private":true}\n');
  fs.writeFileSync(path.join(checkout, "package-lock.json"), LOCKFILE);
  if (partial) {
    // MOV-331's leftover: populated node_modules, no .bin/vitest.
    for (const pkg of ["next", "react", "typescript", "vitest"]) fs.mkdirSync(path.join(checkout, "node_modules", pkg), { recursive: true });
    fs.mkdirSync(path.join(checkout, "node_modules", ".bin"));
    fs.writeFileSync(path.join(checkout, "node_modules", ".bin", "tsc"), "#!/bin/sh\n", { mode: 0o755 });
  }
  const npm = path.join(root, "npm");
  const npmCalls = path.join(root, "npm-calls.jsonl");
  const workerStarts = path.join(root, "worker-starts.jsonl");
  const worker = path.join(root, "worker");
  writeFakeNpm(npm, npmCalls, npmMode);
  writeFixtureWorker(worker, workerStarts, WORKER_COMMANDS);

  const git = (args) => {
    if (args[0] === "rev-parse") return `${HEAD}\n`;
    if (args[0] === "show") return LOCKFILE;
    if (args[0] === "status") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const changedFiles = () => {
    const files = [];
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.name === "node_modules") continue; // gitignored
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else files.push(path.relative(checkout, full));
      }
    };
    walk(checkout);
    return files.filter((file) => !["package.json", "package-lock.json"].includes(file));
  };
  const auditGit = (_command, args) => {
    if (args[0] === "branch") return "agent/MOV-410-dependency-install-fixture\n";
    if (args[0] === "diff") return "";
    if (args[0] === "status") return changedFiles().map((file) => `?? ${file}`).join("\n");
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const readJsonl = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const prepareDependenciesFn = vi.fn((args) => prepareWorktreeDependencies({
    ...args, npmCommand: npm, git,
    env: { ...process.env, GITHUB_TOKEN: "ghp_fixture_dispatcher_token", LINEAR_API_KEY: "lin_api_fixture", MOVIECAL_WORKER_SANDBOX: "1" },
  }));
  const spawnWorkerFn = vi.fn(({ securityContext: _securityContext, ...args }) => spawnWorker({
    ...args, invocation: { command: worker, args: [] }, spawnImpl: (...values) => spawn(...values), killGraceMs: 10,
  }));
  return {
    root, checkout, logRoot: path.join(root, "logs"), prepareDependenciesFn, spawnWorkerFn, auditGit, changedFiles,
    npmCalls: () => readJsonl(npmCalls), workerStarts: () => readJsonl(workerStarts),
  };
}

async function dispatch(fixture, issue) {
  let entry = null;
  const worktreeManager = {
    activeCount: () => 0,
    isPathFreeForIssue: () => true,
    create: vi.fn((args) => {
      entry = { ...args, path: fixture.checkout, status: "active", provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" } };
      return entry;
    }),
    markStatus: vi.fn((_id, status) => { entry.status = status; }),
    loadState: () => ({ [issue.identifier]: entry }),
    isDispatcherOwnedWorktree: () => true,
    worktreeIntegrity: () => ({ intact: true, branch: entry.branch }),
    prepareWorkerSpawn: () => {}, setWorkerPid: () => {},
  };
  const addComment = vi.fn(async () => {});
  const moveToState = vi.fn(async () => {});
  const evidence = [];
  const [result] = await runOnce([issue], {
    linearClient: { moveToState, addComment },
    worktreeManager,
    prepareDependenciesFn: fixture.prepareDependenciesFn,
    spawnWorkerFn: fixture.spawnWorkerFn,
    publishWorkerResultFn: vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true })),
    stateIds: { agentWorking: "working", needsHumanDecision: "human", inReview: "review" },
    concurrencyLimit: 1, iosRunnerOnline: true, secretPresent: () => true,
    worktreeRoot: fixture.root, ghRepo: "owner/repo", logRoot: fixture.logRoot, workerTimeoutMs: 10000,
    dispatcherDelegate: { id: "dispatcher", name: "moviecal-dispatcher" },
    refreshIssueFn: async () => issue,
    repositoryContextFn: () => ({ changedPaths: [] }),
    diffSummaryFn: () => "fixture diff",
    uncommittedChangesFn: () => fixture.changedFiles(),
    auditWorkerResultFn: (args) => auditWorkerResult({ ...args, runner: fixture.auditGit }),
    writeWorkerAuditFn: (logDir, report) => writeWorkerAudit(logDir, report),
    captureVerificationEvidenceFn: (logDir) => { const captured = captureVerificationEvidence(logDir); evidence.push(captured); return captured; },
    captureWorkerUsageFn: () => null,
    logger: { error() {}, warn() {}, log() {} },
  });
  const logDir = path.join(fixture.logRoot, "MOV-410-dependency-install-fixture");
  return { result, logDir, comments: addComment.mock.calls.map(([, body]) => body), moveToState, evidence };
}

function expectInstallOutsideWorkerTranscript(logDir) {
  const transcript = fs.readFileSync(path.join(logDir, "stdout.log"), "utf8");
  const actions = extractToolActions(transcript).map((action) => action.value);
  expect(actions).toEqual(WORKER_COMMANDS);
  expect(actions.some((action) => /\bnpm\b/.test(action))).toBe(false);
  expect(transcript).not.toContain("added 3 packages");
  const audit = JSON.parse(fs.readFileSync(path.join(logDir, "security-audit.json"), "utf8"));
  expect(JSON.stringify(audit)).not.toMatch(/npm ci|ignore-scripts/);
}

describe("dispatcher-side dependency install through the real run loop (MOV-410)", () => {
  it.each(["claude", "codex"])("installs a fresh %s worktree before the worker process starts", async (worker) => {
    const fixture = makeFixture();
    const { result, logDir, evidence } = await dispatch(fixture, issueFor(worker));

    expect(result.outcome).toBe("in-review");
    expect(fixture.prepareDependenciesFn).toHaveBeenCalledTimes(1);
    expect(fixture.spawnWorkerFn).toHaveBeenCalledTimes(1);
    const [npm] = fixture.npmCalls();
    expect(fixture.npmCalls()).toHaveLength(1);
    expect(npm.argv).toEqual([...INSTALL_ARGS]);
    expect(fs.realpathSync(npm.cwd)).toBe(fs.realpathSync(fixture.checkout));
    // Scrubbed like a worker, but never marked as sandboxed.
    expect(npm.credentialKeys).toEqual([]);
    expect(npm.sandboxMarker).toBeNull();
    const [started] = fixture.workerStarts();
    expect(fixture.workerStarts()).toHaveLength(1);
    expect(npm.at).toBeLessThanOrEqual(started.at);

    const manifest = JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8"));
    expect(manifest.command).not.toBe("npm");
    expect(manifest.dependencyInstall).toMatchObject({
      origin: "dispatcher", workerAction: false, verificationEvidence: false,
      status: "installed", command: expect.stringMatching(/npm$/), args: [...INSTALL_ARGS],
      exitCode: 0, commit: HEAD, lockfileSha256: LOCK_SHA, installScripts: { policy: "ignore-scripts", allowlist: [] },
    });
    expectInstallOutsideWorkerTranscript(logDir);
    // The install is not verification evidence: nothing ran `npm run verify`.
    expect(evidence).toEqual([expect.objectContaining({ status: "incomplete", executions: [] })]);
  }, 20000);

  it("repairs a partial node_modules left by a failed worker-side install, then reuses the retained worktree without reinstalling", async () => {
    const fixture = makeFixture({ partial: true });
    const first = await dispatch(fixture, issueFor("codex"));

    expect(first.result.outcome).toBe("in-review");
    expect(fixture.npmCalls()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(first.logDir, "manifest.json"), "utf8")).dependencyInstall)
      .toMatchObject({ status: "installed", reason: "toolchain binaries missing from node_modules/.bin: next, vitest" });
    expect(JSON.parse(fs.readFileSync(path.join(fixture.checkout, INSTALL_MARKER), "utf8"))).toMatchObject({ lockfileSha256: LOCK_SHA });

    const second = await dispatch(fixture, issueFor("codex"));
    expect(second.result.outcome).toBe("in-review");
    expect(fixture.npmCalls()).toHaveLength(1);
    expect(fixture.spawnWorkerFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(path.join(second.logDir, "manifest.json"), "utf8")).dependencyInstall)
      .toMatchObject({ status: "already-prepared", command: null, args: [] });
  }, 20000);

  it.each(["claude", "codex"])("stops an offline %s install before spawn with a precise blocker and no fallback", async (worker) => {
    const fixture = makeFixture({ npmMode: "fail" });
    const { result, logDir, comments, moveToState } = await dispatch(fixture, issueFor(worker));

    expect(result.outcome).toBe("dependency-install-failed");
    expect(result.error).toBe(`${path.join(fixture.root, "npm")} ${INSTALL_ARGS.join(" ")} exited with code 1`);
    expect(fixture.npmCalls()).toHaveLength(1);
    expect(fixture.spawnWorkerFn).not.toHaveBeenCalled();
    expect(fixture.workerStarts()).toEqual([]);
    expect(moveToState).toHaveBeenLastCalledWith(expect.anything(), "human");
    const blocker = comments.find((body) => body.includes("no worker started"));
    expect(blocker).toContain("getaddrinfo ENOTFOUND registry.npmjs.org");
    expect(blocker).toContain(`Lockfile SHA-256: \`${LOCK_SHA}\``);
    expect(blocker).toMatch(/no worker-side fallback, and no sandbox profile was changed/);
    expect(JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8")))
      .toMatchObject({ workerStarted: false, dependencyInstall: { status: "failed", exitCode: 1 } });
    expect(fs.existsSync(path.join(logDir, "stdout.log"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.checkout, INSTALL_MARKER))).toBe(false);
  }, 20000);
});

describe("dispatcher-side dependency install before a repair worker (MOV-410)", () => {
  function repairContext(fixture) {
    const entry = {
      id: "MOV-410", linearIssueId: "id-410", name: "MOV-410-dependency-install-fixture", branch: "agent/MOV-410-dependency-install-fixture",
      path: fixture.checkout, status: "review", prNumber: 410, prUrl: "https://github.com/owner/repo/pull/410",
      worker: "codex", model: "default", headSha: HEAD, provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" },
    };
    const observed = observePullRequest({
      pr: { state: "OPEN", isDraft: true, url: entry.prUrl, headRefOid: HEAD, headRefName: entry.branch, headRepository: { nameWithOwner: "owner/repo" } },
      checks: [{ name: "lane-unit", conclusion: "FAILURE", workflowName: "lane-unit", detailsUrl: "https://ci/example" }],
      requiredChecks: ["lane-unit"],
    });
    return {
      enabled: true, lockHeldFn: () => true,
      ledger: new RepairLedger(path.join(fixture.root, "repair-ledger.json")),
      worktreeManager: { loadState: () => ({ [entry.id]: entry }), activeCount: () => 0, updateEntry: vi.fn() },
      ghRepo: "owner/repo", logRoot: fixture.logRoot, workerTimeoutMs: 10000,
      budgets: { codeRepair: 2, infrastructureRerun: 1, total: 3 }, concurrencyLimit: 1, trustedReviewers: [],
      observePrFn: () => observed, localHeadShaFn: () => HEAD,
      // The fixture's own change is only dirty after the worker runs.
      uncommittedChangesFn: vi.fn(() => []),
      issueForEntryFn: async () => ({ id: "id-410", identifier: "MOV-410", title: "Repair fixture", description: "Fixture only." }),
      prepareDependenciesFn: fixture.prepareDependenciesFn,
      spawnWorkerFn: fixture.spawnWorkerFn,
      workerInvocationFn: () => ({ command: "codex", args: [] }),
      auditWorkerResultFn: (args) => auditWorkerResult({ ...args, runner: fixture.auditGit }),
      writeWorkerAuditFn: (logDir, report) => writeWorkerAudit(logDir, report),
      publishRepairResultFn: vi.fn(() => ({ number: 410, url: entry.prUrl, headSha: "def456" })),
      rerunFailedJobsFn: vi.fn(() => ({ rerun: [], skipped: [], errors: [] })),
      collectRepairEvidenceFn: () => ({ ciLogs: "failure", prBody: "", diff: "", reviewComments: "" }),
      commentOnPullRequestFn: vi.fn(),
      stateIds: { needsHumanDecision: "human" },
      logger: { error() {}, warn() {} },
    };
  }

  it("installs before the repair worker starts and keeps the install out of its audited actions", async () => {
    const fixture = makeFixture();
    const ctx = repairContext(fixture);

    const [result] = await runRepairPass(ctx);

    expect(result.outcome).toBe("repaired");
    expect(fixture.npmCalls()).toHaveLength(1);
    expect(fixture.spawnWorkerFn).toHaveBeenCalledTimes(1);
    expect(fixture.npmCalls()[0].at).toBeLessThanOrEqual(fixture.workerStarts()[0].at);
    const logDir = path.join(fixture.logRoot, `MOV-410-dependency-install-fixture-repair-${HEAD.slice(0, 12)}`);
    expect(JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8")).dependencyInstall)
      .toMatchObject({ status: "installed", origin: "dispatcher", lockfileSha256: LOCK_SHA });
    expectInstallOutsideWorkerTranscript(logDir);
  }, 20000);

  it("closes the repair without a worker when the install fails", async () => {
    const fixture = makeFixture({ npmMode: "fail" });
    const ctx = repairContext(fixture);

    const [result] = await runRepairPass(ctx);

    expect(result.outcome).toBe("repair-failed");
    expect(fixture.spawnWorkerFn).not.toHaveBeenCalled();
    expect(fixture.workerStarts()).toEqual([]);
    expect(ctx.publishRepairResultFn).not.toHaveBeenCalled();
    expect(ctx.commentOnPullRequestFn.mock.calls.at(-1)[0].body).toContain("getaddrinfo ENOTFOUND registry.npmjs.org");
  }, 20000);
});

// The production Git reads. Skipped inside a worker's own sandboxed
// `npm run verify`, where Git cannot execute (MOV-274); CI and local runs
// outside the sandbox cover it.
describe.skipIf(isInsideWorkerSandboxEnv())("dependency inputs checked with real Git (MOV-410)", () => {
  it("installs from the committed lockfile, then refuses once the lockfile drifts from HEAD", async () => {
    const fixture = makeFixture();
    const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: fixture.checkout, encoding: "utf8" });
    git("init", "--quiet");
    git("add", "package.json", "package-lock.json");
    git("commit", "--quiet", "-m", "fixture");
    const head = git("rev-parse", "HEAD").trim();
    const npm = path.join(fixture.root, "npm");
    const logDir = path.join(fixture.root, "logs");

    const installed = await prepareWorktreeDependencies({ worktreePath: fixture.checkout, logDir, npmCommand: npm });
    expect(installed).toMatchObject({ ok: true, status: "installed", commit: head, lockfileSha256: LOCK_SHA });

    fs.rmSync(path.join(fixture.checkout, "node_modules"), { recursive: true, force: true });
    fs.writeFileSync(path.join(fixture.checkout, "package-lock.json"), LOCKFILE.replace("fixture", "drifted"));
    const refused = await prepareWorktreeDependencies({ worktreePath: fixture.checkout, logDir, npmCommand: npm });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/dependency inputs differ from the committed HEAD .*M package-lock\.json/);
    expect(refused.lockfileSha256).toBe(LOCK_SHA);
    expect(fixture.npmCalls()).toHaveLength(1);
  }, 20000);
});
