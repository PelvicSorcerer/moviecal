// Trusted worktree dependency install (MOV-410 / MOV-411).
//
// Workers have no outbound network, so a worker-side `npm ci` cannot work
// (MOV-331 failed with ENOTFOUND inside the confined Codex executor). The
// dispatcher therefore prepares `node_modules` itself, as trusted code outside
// the worker sandbox, before a worker starts. That makes this module an
// unsandboxed code-execution path over worktree content, so it is deliberately
// narrow:
//
// - `npm ci` only, never `npm install`, against the dependency inputs committed
//   at the worktree's HEAD. Before an install, `package.json`,
//   `package-lock.json`, `npm-shrinkwrap.json` (which `npm ci` prefers over the
//   lockfile) and `.npmrc` must match that commit byte for byte (an input absent
//   at HEAD must also be absent on disk), so a retained worktree's uncommitted
//   edits cannot steer the install. A symlinked or non-directory
//   `node_modules` is refused rather than handed to npm's removal step.
// - `--ignore-scripts`. No dependency lifecycle script runs unsandboxed by
//   default. INSTALL_SCRIPT_ALLOWLIST names any package whose script the
//   toolchain truly needs; its scripts then run in a separate `npm rebuild`
//   step. It is empty: the lockfile's only install scripts are `sharp`
//   (`install/check.js` verifies a prebuilt binary that ships as the optional
//   `@img/sharp-*` dependency), `unrs-resolver` (a postinstall that checks the
//   native binding shipped as the optional `@unrs/resolver-binding-*`
//   dependency) and `fsevents` (no lifecycle script; prebuilt). Adding an
//   entry is a security review decision, not a convenience.
// - The worker's scrubbed environment (`sanitizedWorkerEnvironment`) minus the
//   sandbox marker, every inherited npm configuration variable, provider,
//   dispatcher, Linear, GitHub and Git variables, and anything
//   credential-shaped. `--userconfig=/dev/null` ignores the user npmrc, which
//   is a registry-credential store the worker cannot read. PATH keeps only
//   absolute entries outside the worktree, so a planted `node_modules/.bin/npm`
//   cannot shadow npm.
// - Completeness is judged from concrete toolchain binaries plus a dispatcher
//   marker tied to the committed lockfile hash, never from `node_modules`
//   merely existing (MOV-331's failed install left a populated `node_modules`
//   with no `.bin/vitest`). A missing, truncated, corrupt or stale marker, or a
//   missing binary, means "reinstall". The marker lives inside `node_modules`,
//   which the worker can write, so a forged marker can only skip an install
//   the worker itself then lacks; it never widens what this module executes.
// - A bounded timeout. DEFAULT_INSTALL_TIMEOUT_MS is 10 minutes: a cold-cache
//   `npm ci` of this lockfile takes one to two minutes on an ordinary
//   connection, so ten leaves ample room for a slow registry while still
//   failing a hung install well inside the 45-minute worker timeout. npm runs
//   as its own process group; a timeout sends SIGTERM and then SIGKILL to the
//   whole group, and the group is also killed when the dispatcher exits or
//   receives SIGINT, SIGTERM or SIGHUP while the install runs. `onSpawn`
//   exposes the group leader so a caller can record it for startup recovery.
// - npm output goes only to `dependency-install.log` beside the run logs,
//   never to the worker's `stdout.log`, so it is not part of the transcript
//   that the security audit and verification evidence read. The structured
//   result goes to `dependency-install.json`.
//
// Callers must run this while no worker process is using the worktree. Every
// failure is returned as a structured not-ok result; nothing throws past
// `ensureWorktreeDependencies`. All I/O is injectable so tests never reach
// the network or a real npm.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { sanitizedWorkerEnvironment, WORKER_SANDBOX_ENV_VAR } from "./worker-guard.mjs";

export const DEPENDENCY_INPUT_FILES = Object.freeze(["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc"]);
export const REQUIRED_TOOLCHAIN_BINARIES = Object.freeze(["tsc", "next", "vitest"]);
export const INSTALL_SCRIPT_ALLOWLIST = Object.freeze([]);
export const DEPENDENCY_INSTALL_MARKER = path.join("node_modules", ".moviecal-dependency-install.json");
export const DEPENDENCY_INSTALL_LOG = "dependency-install.log";
export const DEPENDENCY_INSTALL_RECORD = "dependency-install.json";
export const MARKER_SCHEMA_VERSION = 1;
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 5000;

const MAX_MARKER_BYTES = 64 * 1024;
const MAX_DETAIL_CHARS = 500;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PARENT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// Git hardening values set by sanitizedWorkerEnvironment; every other GIT_*
// variable (GIT_DIR, GIT_WORK_TREE, ...) is dropped.
const GIT_HARDENING_KEYS = new Set(["GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND"]);
const DROPPED_PREFIX_RE = /^(?:npm_|MOVIECAL_|LINEAR_|GITHUB_|GH_|GIT_|ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|SUPABASE_|VERCEL_|AWS_|SSH_)/i;
const CREDENTIAL_SHAPED_RE = /AUTH|CREDENTIAL|COOKIE|PASSPHRASE|PASSWORD|SECRET|TOKEN|(?:^|_)PAT$|(?:^|_)KEY$/i;
const DROPPED_KEYS = new Set(["NODE_OPTIONS", "NODE_PATH"]);
const PROXY_WITH_USERINFO_RE = /:\/\/[^/@\s]*@/;

/**
 * `npm ci` arguments. `--userconfig=/dev/null` ignores the user npmrc; the
 * committed project `.npmrc` (verified against HEAD) still applies.
 */
export function installArguments() {
  return ["ci", "--ignore-scripts", "--userconfig=/dev/null", "--no-audit", "--no-fund", "--no-update-notifier"];
}

/** Arguments for running only the allowlisted packages' lifecycle scripts. */
export function allowlistedScriptArguments(allowlist = INSTALL_SCRIPT_ALLOWLIST) {
  return ["rebuild", "--userconfig=/dev/null", "--no-audit", "--no-fund", "--no-update-notifier", ...allowlist];
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The environment handed to npm. Starts from the worker's scrubbed
 * environment, then removes the sandbox marker, inherited npm configuration
 * and anything provider-, dispatcher-, forge- or credential-shaped.
 */
export function dependencyInstallEnvironment(source = process.env, { worktreePath } = {}) {
  const base = sanitizedWorkerEnvironment(source);
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (GIT_HARDENING_KEYS.has(key)) {
      env[key] = value;
      continue;
    }
    if (key === WORKER_SANDBOX_ENV_VAR || DROPPED_KEYS.has(key)) continue;
    if (DROPPED_PREFIX_RE.test(key) || CREDENTIAL_SHAPED_RE.test(key)) continue;
    if (/_proxy$/i.test(key) && PROXY_WITH_USERINFO_RE.test(value)) continue;
    env[key] = value;
  }
  const root = worktreePath ? path.resolve(worktreePath) : null;
  env.PATH = String(env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && !(root && isWithin(root, path.resolve(entry))))
    .join(path.delimiter);
  return env;
}

/**
 * Read the dependency inputs committed at HEAD. Returns the resolved commit
 * and each input's committed bytes (null when absent at that commit). Throws
 * when HEAD is unreadable or an input is not a regular file there.
 */
export function readCommittedDependencyInputs(worktreePath, { execImpl = execFileSync } = {}) {
  const git = (args) => execImpl("git", ["-C", worktreePath, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const headSha = git(["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();
  const files = Object.fromEntries(DEPENDENCY_INPUT_FILES.map((name) => [name, null]));
  const listing = git(["ls-tree", "-z", headSha, "--", ...DEPENDENCY_INPUT_FILES]).toString();
  for (const record of listing.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    const name = record.slice(tab + 1);
    if (!Object.hasOwn(files, name)) continue;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`${name} at ${headSha} is not a regular file (mode ${mode})`);
    }
    files[name] = git(["cat-file", "blob", oid]);
  }
  return { headSha, files };
}

/** Committed inputs whose on-disk state differs from HEAD. */
export function findDirtyDependencyInputs(worktreePath, committedFiles, { fsImpl = fs } = {}) {
  const dirty = [];
  for (const name of DEPENDENCY_INPUT_FILES) {
    const committed = committedFiles[name] ?? null;
    const filePath = path.join(worktreePath, name);
    let stat = null;
    try {
      stat = fsImpl.lstatSync(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        dirty.push({ path: name, reason: "unreadable" });
        continue;
      }
    }
    if (!stat) {
      if (committed) dirty.push({ path: name, reason: "missing" });
      continue;
    }
    if (!committed) {
      dirty.push({ path: name, reason: "untracked" });
      continue;
    }
    if (!stat.isFile()) {
      dirty.push({ path: name, reason: "not-regular-file" });
      continue;
    }
    if (!Buffer.from(fsImpl.readFileSync(filePath)).equals(Buffer.from(committed))) {
      dirty.push({ path: name, reason: "modified" });
    }
  }
  return dirty;
}

function isExecutableFile(fsImpl, filePath) {
  try {
    const stat = fsImpl.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Inspect `node_modules`. `safe` is false when it is a symlink or not a
 * directory; `missingBinaries` lists toolchain binaries that do not resolve
 * to an executable file (a dangling `.bin` link counts as missing).
 */
export function inspectToolchain(worktreePath, { fsImpl = fs } = {}) {
  const nodeModules = path.join(worktreePath, "node_modules");
  let stat;
  try {
    stat = fsImpl.lstatSync(nodeModules);
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, safe: true, missingBinaries: [...REQUIRED_TOOLCHAIN_BINARIES] };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { present: true, safe: false, missingBinaries: [...REQUIRED_TOOLCHAIN_BINARIES] };
  }
  const missingBinaries = REQUIRED_TOOLCHAIN_BINARIES.filter((name) => !isExecutableFile(fsImpl, path.join(nodeModules, ".bin", name)));
  return { present: true, safe: true, missingBinaries };
}

/**
 * Parse the install marker. Returns `{ state: "missing" }`,
 * `{ state: "corrupt", detail }` or `{ state: "valid", marker }`; never throws.
 */
export function readInstallMarker(worktreePath, { fsImpl = fs } = {}) {
  const markerPath = path.join(worktreePath, DEPENDENCY_INSTALL_MARKER);
  try {
    const stat = fsImpl.lstatSync(markerPath);
    if (!stat.isFile()) return { state: "corrupt", detail: "marker is not a regular file" };
    if (stat.size > MAX_MARKER_BYTES) return { state: "corrupt", detail: `marker exceeds ${MAX_MARKER_BYTES} bytes` };
    const marker = JSON.parse(String(fsImpl.readFileSync(markerPath, "utf8")));
    if (
      !marker || typeof marker !== "object" || Array.isArray(marker) ||
      marker.schemaVersion !== MARKER_SCHEMA_VERSION ||
      typeof marker.lockfileSha256 !== "string" || !SHA256_RE.test(marker.lockfileSha256) ||
      typeof marker.installedAt !== "string"
    ) {
      return { state: "corrupt", detail: "marker has an unexpected shape" };
    }
    return { state: "valid", marker };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" };
    return { state: "corrupt", detail: error instanceof SyntaxError ? "marker is not valid JSON" : String(error?.message || error) };
  }
}

/**
 * Why an install is needed, or null when the toolchain is complete and the
 * marker matches the committed lockfile.
 */
export function installNeed(toolchain, markerRead, lockfileSha256) {
  if (!toolchain.present) return "fresh";
  if (toolchain.missingBinaries.length > 0) return "toolchain-incomplete";
  if (markerRead.state === "missing") return "marker-missing";
  if (markerRead.state === "corrupt") return "marker-corrupt";
  if (markerRead.marker.lockfileSha256 !== lockfileSha256) return "marker-stale";
  return null;
}

function writeInstallMarker(worktreePath, marker, fsImpl) {
  const markerPath = path.join(worktreePath, DEPENDENCY_INSTALL_MARKER);
  const tmpPath = `${markerPath}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
  fsImpl.renameSync(tmpPath, markerPath);
}

/** Signal a whole process group, ignoring one that is already gone. */
export function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // process group already gone
  }
}

/**
 * Kill `pid`'s process group if the dispatcher exits or receives SIGINT,
 * SIGTERM or SIGHUP. A signal nobody else handles is re-raised after cleanup
 * so the dispatcher's default termination is preserved. Returns a release
 * function that removes every listener.
 */
export function guardParentExit(pid, { processImpl = process, killImpl = killProcessGroup } = {}) {
  let released = false;
  const onExit = () => killImpl(pid, "SIGKILL");
  const handlers = new Map();
  const release = () => {
    if (released) return;
    released = true;
    processImpl.removeListener("exit", onExit);
    for (const [signal, handler] of handlers) processImpl.removeListener(signal, handler);
  };
  processImpl.on("exit", onExit);
  for (const signal of PARENT_SIGNALS) {
    const handler = () => {
      killImpl(pid, "SIGKILL");
      release();
      if (processImpl.listenerCount(signal) === 0) processImpl.kill(processImpl.pid, signal);
    };
    handlers.set(signal, handler);
    processImpl.on(signal, handler);
  }
  return release;
}

function runNpmStep({ npmCommand, args, cwd, env, logFd, spawnImpl, timers, killImpl, processImpl, timeoutMs, killGraceMs, onSpawn }) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let releaseGuard = () => {};
    const pendingTimers = [];
    const schedule = (fn, ms) => pendingTimers.push(timers.setTimeout(fn, ms));
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      for (const handle of pendingTimers) timers.clearTimeout(handle);
      releaseGuard();
      // Reap anything npm left in its group, whatever the outcome.
      if (child?.pid) killImpl(child.pid, "SIGKILL");
      resolve({ pid: child?.pid ?? null, ...outcome });
    };
    try {
      child = spawnImpl(npmCommand, args, { cwd, env, stdio: ["ignore", logFd, logFd], detached: true });
    } catch (error) {
      finish({ outcome: "spawn-error", error: String(error?.message || error) });
      return;
    }
    child.once("error", (error) => finish({ outcome: timedOut ? "timeout" : "spawn-error", error: String(error?.message || error) }));
    child.once("exit", (exitCode, signal) => finish({ outcome: timedOut ? "timeout" : "exited", exitCode, signal, killConfirmed: true }));
    if (!child.pid) return;
    releaseGuard = guardParentExit(child.pid, { processImpl, killImpl });
    try {
      onSpawn?.({ pid: child.pid });
    } catch {
      // recording the group leader is best effort; the guard and timeout still apply
    }
    schedule(() => {
      timedOut = true;
      killImpl(child.pid, "SIGTERM");
      schedule(() => {
        killImpl(child.pid, "SIGKILL");
        schedule(() => finish({ outcome: "timeout", killConfirmed: false }), killGraceMs);
      }, killGraceMs);
    }, timeoutMs);
  });
}

function bounded(text) {
  const value = String(text ?? "");
  return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…` : value;
}

function stepFailure(step, run, timeoutMs) {
  if (run.outcome === "spawn-error") return { reason: "spawn-error", detail: bounded(`could not start npm ${step}: ${run.error}`) };
  if (run.outcome === "timeout") {
    const cleanup = run.killConfirmed ? "its process group was killed" : "its process group was signalled but exit was not confirmed";
    return { reason: "timeout", detail: `npm ${step} exceeded ${timeoutMs} ms; ${cleanup}` };
  }
  const how = run.signal ? `was killed by ${run.signal}` : `exited with code ${run.exitCode}`;
  return { reason: "npm-failed", detail: `npm ${step} ${how}` };
}

/**
 * Ensure the worktree has a complete toolchain installed from its committed
 * lockfile. Resolves to a structured result; never rejects.
 */
export async function ensureWorktreeDependencies({
  worktreePath,
  logDir,
  sourceEnv = process.env,
  fsImpl = fs,
  spawnImpl = nodeSpawn,
  readCommittedInputs = readCommittedDependencyInputs,
  now = () => new Date(),
  timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
  killImpl = killProcessGroup,
  processImpl = process,
  npmCommand = "npm",
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  scriptAllowlist = INSTALL_SCRIPT_ALLOWLIST,
  onSpawn,
} = {}) {
  const startedAt = now();
  const logPath = logDir ? path.join(logDir, DEPENDENCY_INSTALL_LOG) : null;
  const result = {
    schemaVersion: 1,
    ok: false,
    status: "failed",
    reason: null,
    detail: null,
    installReason: null,
    worktreePath: worktreePath ?? null,
    headSha: null,
    lockfile: null,
    lockfileSha256: null,
    command: npmCommand,
    args: installArguments(),
    scriptAllowlist: [...scriptAllowlist],
    environmentKeys: [],
    timeoutMs,
    exitCode: null,
    signal: null,
    pid: null,
    dirtyInputs: [],
    missingBinaries: [],
    logPath,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
  };
  const done = (fields) => {
    const finished = now();
    return Object.assign(result, fields, { finishedAt: finished.toISOString(), durationMs: finished.getTime() - startedAt.getTime() });
  };
  const fail = (reason, detail, fields = {}) => done({ ok: false, status: "failed", reason, detail: bounded(detail), ...fields });

  let logFd = null;
  const log = (line) => {
    if (logFd !== null) fsImpl.writeSync(logFd, `${line}\n`);
  };
  try {
    if (!worktreePath || !logDir) return fail("invalid-arguments", "worktreePath and logDir are required");

    let committed;
    try {
      committed = readCommittedInputs(worktreePath);
    } catch (error) {
      return fail("committed-inputs-unreadable", `could not read dependency inputs at HEAD: ${error?.message || error}`);
    }
    result.headSha = committed.headSha;
    const lockfile = committed.files["npm-shrinkwrap.json"] ? "npm-shrinkwrap.json" : "package-lock.json";
    const lockBytes = committed.files[lockfile];
    if (!committed.files["package.json"] || !lockBytes) {
      return fail("missing-lockfile", `package.json and package-lock.json must both be committed at ${committed.headSha}`);
    }
    result.lockfile = lockfile;
    result.lockfileSha256 = createHash("sha256").update(lockBytes).digest("hex");

    const toolchain = inspectToolchain(worktreePath, { fsImpl });
    if (!toolchain.safe) {
      return fail("unsafe-node-modules", "node_modules is a symlink or not a directory; refusing to let npm remove or write through it");
    }
    const need = installNeed(toolchain, readInstallMarker(worktreePath, { fsImpl }), result.lockfileSha256);
    if (!need) return done({ ok: true, status: "current" });
    result.installReason = need;
    result.missingBinaries = toolchain.missingBinaries;

    const dirtyInputs = findDirtyDependencyInputs(worktreePath, committed.files, { fsImpl });
    if (dirtyInputs.length > 0) {
      const list = dirtyInputs.map((entry) => `${entry.path} (${entry.reason})`).join(", ");
      return fail("dirty-dependency-inputs", `dependency inputs differ from ${committed.headSha}: ${list}`, { dirtyInputs });
    }

    const env = dependencyInstallEnvironment(sourceEnv, { worktreePath });
    result.environmentKeys = Object.keys(env).sort();

    try {
      fsImpl.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      logFd = fsImpl.openSync(logPath, "a", 0o600);
    } catch (error) {
      return fail("log-unavailable", `could not open ${logPath}: ${error?.message || error}`);
    }
    fsImpl.rmSync(path.join(worktreePath, DEPENDENCY_INSTALL_MARKER), { force: true });

    const steps = [{ step: "ci", args: installArguments() }];
    if (scriptAllowlist.length > 0) steps.push({ step: "rebuild", args: allowlistedScriptArguments(scriptAllowlist) });
    for (const { step, args } of steps) {
      log(`--- ${now().toISOString()} ${npmCommand} ${args.join(" ")} (${need}) in ${worktreePath} at ${committed.headSha}`);
      const run = await runNpmStep({ npmCommand, args, cwd: worktreePath, env, logFd, spawnImpl, timers, killImpl, processImpl, timeoutMs, killGraceMs, onSpawn });
      Object.assign(result, { pid: run.pid, exitCode: run.exitCode ?? null, signal: run.signal ?? null });
      log(`--- ${now().toISOString()} npm ${step} ${run.outcome} exitCode=${run.exitCode ?? ""} signal=${run.signal ?? ""}`);
      if (run.outcome !== "exited" || run.exitCode !== 0) {
        const failure = stepFailure(step, run, timeoutMs);
        return fail(failure.reason, failure.detail, { step });
      }
    }

    const after = inspectToolchain(worktreePath, { fsImpl });
    if (!after.safe || after.missingBinaries.length > 0) {
      return fail("toolchain-incomplete-after-install", `npm ci succeeded but node_modules/.bin is missing: ${after.missingBinaries.join(", ")}`, { missingBinaries: after.missingBinaries });
    }
    try {
      writeInstallMarker(worktreePath, {
        schemaVersion: MARKER_SCHEMA_VERSION,
        lockfile,
        lockfileSha256: result.lockfileSha256,
        headSha: committed.headSha,
        args: installArguments(),
        scriptAllowlist: [...scriptAllowlist],
        installedAt: now().toISOString(),
      }, fsImpl);
    } catch (error) {
      return fail("marker-write-failed", `installed, but could not write ${DEPENDENCY_INSTALL_MARKER}: ${error?.message || error}`);
    }
    return done({ ok: true, status: "installed", missingBinaries: [] });
  } catch (error) {
    return fail("unexpected-error", String(error?.message || error));
  } finally {
    if (logFd !== null) {
      try {
        fsImpl.closeSync(logFd);
      } catch {
        // already closed
      }
    }
  }
}

/** Write the install result to `dependency-install.json` in the run-log directory. */
export function writeDependencyInstallRecord(logDir, result, { fsImpl = fs, now = () => new Date() } = {}) {
  fsImpl.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const recordPath = path.join(logDir, DEPENDENCY_INSTALL_RECORD);
  const tmpPath = `${recordPath}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify({ ...result, recordedAt: now().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(tmpPath, recordPath);
  return recordPath;
}

const BLOCKER_GUIDANCE = {
  "invalid-arguments": "The dispatcher called the installer without a worktree or log directory. This is a dispatcher bug.",
  "committed-inputs-unreadable": "The dispatcher could not read the dependency inputs committed at the worktree's HEAD. Check that the worktree is intact and on its assigned branch.",
  "missing-lockfile": "`package.json` and `package-lock.json` must both be committed. `npm ci` cannot run without a committed lockfile.",
  "unsafe-node-modules": "`node_modules` is a symlink or not a directory. Remove it from the retained worktree so the dispatcher can reinstall.",
  "dirty-dependency-inputs": "Uncommitted changes to dependency inputs cannot steer an unsandboxed install. Commit or discard these changes in the retained worktree, then requeue.",
  "log-unavailable": "The install log could not be opened, so the dispatcher did not run npm. Check the run-log directory's permissions and free space.",
  "spawn-error": "npm could not be started. Check that `npm` is on the dispatcher's PATH.",
  "npm-failed": "`npm ci` failed. Read the install log; a registry or network failure is usually transient.",
  timeout: "The install exceeded its time limit and was killed. Check registry reachability, then requeue.",
  "toolchain-incomplete-after-install": "npm reported success but required toolchain binaries are missing. Check the lockfile's devDependencies.",
  "marker-write-failed": "Dependencies were installed, but the completion marker could not be written, so the install cannot be trusted as complete.",
  "unexpected-error": "An unexpected error stopped the install. Read the detail and the install log.",
};

function code(value) {
  return `\`${String(value).replaceAll("`", "'")}\``;
}

/**
 * A Markdown blocker section for a failed install, or null when it succeeded.
 */
export function renderDependencyInstallBlocker(result) {
  if (!result || result.ok) return null;
  const lines = [`### Dependency install blocked: ${code(result.reason)}`, "", BLOCKER_GUIDANCE[result.reason] || BLOCKER_GUIDANCE["unexpected-error"], ""];
  if (result.detail) lines.push(`- Detail: ${code(bounded(result.detail))}`);
  if (result.worktreePath) lines.push(`- Worktree: ${code(result.worktreePath)}`);
  if (result.headSha) lines.push(`- Commit: ${code(result.headSha)}`);
  if (result.lockfileSha256) lines.push(`- Lockfile: ${code(result.lockfile)} (sha256 ${code(result.lockfileSha256)})`);
  if (result.installReason) lines.push(`- Why an install was needed: ${code(result.installReason)}`);
  if (result.step) lines.push(`- Command: ${code([result.command, ...(result.step === "rebuild" ? allowlistedScriptArguments(result.scriptAllowlist) : result.args)].join(" "))}`);
  if (result.exitCode !== null && result.exitCode !== undefined) lines.push(`- Exit code: ${code(result.exitCode)}`);
  if (result.signal) lines.push(`- Signal: ${code(result.signal)}`);
  if (result.dirtyInputs?.length) lines.push(`- Dirty inputs: ${result.dirtyInputs.map((entry) => `${code(entry.path)} (${entry.reason})`).join(", ")}`);
  if (result.reason === "toolchain-incomplete-after-install" && result.missingBinaries?.length) {
    lines.push(`- Missing binaries: ${result.missingBinaries.map(code).join(", ")}`);
  }
  if (result.logPath && result.step) lines.push(`- Install log: ${code(result.logPath)}`);
  return lines.join("\n");
}
