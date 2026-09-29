// Trusted dependency preparation for a worker's worktree (MOV-410).
//
// Workers have no outbound network, so a worker-side `npm ci` cannot work
// (MOV-331 failed with ENOTFOUND inside the Codex executor) and must not be
// made to work by loosening either sandbox. The dispatcher installs instead,
// outside the worker sandbox and before `spawnWorker()`, so the toolchain
// exists before the worker's first exact `npm run verify` (MOV-281).
//
// This runs unsandboxed, so it is kept narrow:
//
//   - `npm ci` only, never `npm install`, against the lockfile committed at
//     the worktree's HEAD. When an install is needed, `package.json`,
//     `package-lock.json`, and `.npmrc` must match that commit exactly, so a
//     retained worktree's uncommitted edits can never steer it.
//   - `--ignore-scripts`: no dependency lifecycle script runs unsandboxed.
//     `INSTALL_SCRIPT_ALLOWLIST` names the packages whose scripts the
//     toolchain truly needs, and it is empty (see docs/operators/local-execution.md).
//   - The worker's scrubbed environment, minus the sandbox marker (this is
//     not inside the sandbox) and any inherited npm configuration, with the
//     user npmrc (a registry-credential store the worker cannot read) ignored.
//   - Output goes to `dependency-install.log`, never `stdout.log`, so it is
//     not part of the worker transcript the security audit and verification
//     evidence read. The record is stored in the run manifest instead.
//
// Completeness is judged from toolchain binaries plus a dispatcher marker
// tied to the committed lockfile, not from `node_modules` merely existing:
// MOV-331's failed install left a populated `node_modules` with no
// `.bin/vitest`.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizedWorkerEnvironment, WORKER_SANDBOX_ENV_VAR } from "./worker-guard.mjs";
import { redactWorkerOutput } from "./worker-spawn.mjs";

/** Binaries `npm run verify` needs: typecheck, build, and both Vitest lanes. */
export const TOOLCHAIN_BINARIES = Object.freeze(["tsc", "next", "vitest"]);

/**
 * Packages whose install scripts run after `npm ci --ignore-scripts`, via
 * `npm rebuild <name>`. Empty: every install script in the lockfile (fsevents,
 * sharp, unrs-resolver) only builds or checks a native binding that already
 * ships prebuilt, and `npm run verify` passes without any of them.
 */
export const INSTALL_SCRIPT_ALLOWLIST = Object.freeze([]);

export const DEPENDENCY_INPUT_FILES = Object.freeze(["package.json", "package-lock.json", ".npmrc"]);
export const INSTALL_ARGS = Object.freeze(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--userconfig=/dev/null"]);
export const INSTALL_MARKER = path.join("node_modules", ".moviecal-dependency-install.json");
export const INSTALL_RECORD_FILENAME = "dependency-install.json";
export const INSTALL_LOG_FILENAME = "dependency-install.log";
export const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

function gitRunner(args, { cwd }) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The environment the install runs with: the same credential scrub as a
 * worker, and nothing that claims sandboxing or carries npm configuration.
 */
export function dependencyInstallEnvironment(source = process.env) {
  const env = sanitizedWorkerEnvironment(source);
  delete env[WORKER_SANDBOX_ENV_VAR];
  for (const key of Object.keys(env)) {
    if (/^npm_/i.test(key)) delete env[key];
  }
  env.npm_config_update_notifier = "false";
  return env;
}

/**
 * Whether the worktree holds a complete dispatcher install of this lockfile.
 * `unsafe` means npm must not run over what is there (for example a
 * symlinked `node_modules` whose deletion could reach outside the worktree).
 */
export function toolchainStatus(worktreePath, { lockfileSha256 = null, requireMarker = true, fsImpl = fs } = {}) {
  const nodeModules = path.join(worktreePath, "node_modules");
  let stat = null;
  try {
    stat = fsImpl.lstatSync(nodeModules);
  } catch {
    return { complete: false, unsafe: false, missing: [...TOOLCHAIN_BINARIES], reason: "node_modules is absent" };
  }
  if (!stat.isDirectory()) {
    return { complete: false, unsafe: true, missing: [...TOOLCHAIN_BINARIES], reason: "node_modules is not a real directory (symlink or file)" };
  }
  // existsSync follows the .bin symlink, so a dangling link counts as missing.
  const missing = TOOLCHAIN_BINARIES.filter((bin) => !fsImpl.existsSync(path.join(nodeModules, ".bin", bin)));
  if (missing.length) {
    return { complete: false, unsafe: false, missing, reason: `toolchain binaries missing from node_modules/.bin: ${missing.join(", ")}` };
  }
  if (requireMarker) {
    let marker = null;
    try {
      marker = JSON.parse(fsImpl.readFileSync(path.join(worktreePath, INSTALL_MARKER), "utf8"));
    } catch {
      return { complete: false, unsafe: false, missing: [], reason: "node_modules was not installed by the dispatcher" };
    }
    if (marker?.lockfileSha256 !== lockfileSha256) {
      return { complete: false, unsafe: false, missing: [], reason: "node_modules was installed from a different lockfile" };
    }
  }
  return { complete: true, unsafe: false, missing: [], reason: null };
}

function runInstallCommand({ command, args, cwd, env, logStream, spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      resolve({ exitCode: null, signal: null, error: error.message, timedOut: false });
      return;
    }
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs) : null;
    const write = (chunk) => logStream.write(redactWorkerOutput(chunk.toString("utf8")));
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, signal: null, error: error.message, timedOut });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, signal: signal || null, error: null, timedOut });
    });
  });
}

function outputTail(logPath, lines = 40) {
  try {
    return fs.readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Write the install record into `manifest.json` when no worker will run. On
 * the normal path `spawnWorker()` embeds the same record in its manifest.
 */
export function writeDependencyInstallManifest(logDir, record, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(logDir, { recursive: true });
  const manifestPath = path.join(logDir, "manifest.json");
  fsImpl.writeFileSync(manifestPath, JSON.stringify({ workerStarted: false, exitCode: null, dependencyInstall: record }, null, 2) + "\n");
  return manifestPath;
}

/**
 * Make the worktree's toolchain complete, or explain exactly why not.
 *
 * Resolves to a record with `ok`; it does not throw for an install failure.
 * `status` is `already-prepared`, `installed`, or `failed`.
 */
export async function prepareWorktreeDependencies({
  worktreePath,
  logDir,
  env = process.env,
  npmCommand = "npm",
  allowlist = INSTALL_SCRIPT_ALLOWLIST,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  git = gitRunner,
  spawnImpl = spawn,
  fsImpl = fs,
  now = () => new Date(),
} = {}) {
  fsImpl.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, INSTALL_LOG_FILENAME);
  const installEnv = dependencyInstallEnvironment(env);
  const record = {
    origin: "dispatcher",
    workerAction: false,
    verificationEvidence: false,
    ok: false,
    status: "failed",
    reason: null,
    worktreePath,
    commit: null,
    lockfile: "package-lock.json",
    lockfileSha256: null,
    command: npmCommand,
    args: [...INSTALL_ARGS],
    exitCode: null,
    signal: null,
    startedAt: now().toISOString(),
    endedAt: null,
    installScripts: { policy: "ignore-scripts", allowlist: [...allowlist], rebuilds: [] },
    environmentKeys: Object.keys(installEnv).sort(),
    toolchain: { required: [...TOOLCHAIN_BINARIES], before: null, missingAfter: null },
    logPath: null,
  };
  const finish = (fields) => {
    Object.assign(record, fields, { endedAt: now().toISOString() });
    fsImpl.writeFileSync(path.join(logDir, INSTALL_RECORD_FILENAME), JSON.stringify(record, null, 2) + "\n");
    return record;
  };

  try {
    record.commit = String(git(["rev-parse", "HEAD"], { cwd: worktreePath })).trim();
    record.lockfileSha256 = sha256(git(["show", `${record.commit}:package-lock.json`], { cwd: worktreePath }));
  } catch (error) {
    return finish({ reason: `could not read the committed package-lock.json at the worktree's HEAD: ${error.message}` });
  }

  const before = toolchainStatus(worktreePath, { lockfileSha256: record.lockfileSha256, fsImpl });
  record.toolchain.before = before.complete ? "complete" : before.reason;
  if (before.complete) return finish({ ok: true, status: "already-prepared", command: null, args: [] });
  if (before.unsafe) return finish({ reason: `refusing to run npm ci: ${before.reason}` });

  let drift;
  try {
    drift = String(git(["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...DEPENDENCY_INPUT_FILES], { cwd: worktreePath })).trim();
  } catch (error) {
    return finish({ reason: `could not confirm dependency inputs match HEAD: ${error.message}` });
  }
  if (drift) {
    return finish({ reason: `dependency inputs differ from the committed HEAD ${record.commit}, so the dispatcher will not install from them: ${drift.split("\n").join("; ")}` });
  }

  record.logPath = logPath;
  const logStream = fsImpl.createWriteStream(logPath);
  logStream.on("error", () => {});
  const closeLog = () => new Promise((resolve) => logStream.end(resolve));
  const run = (args) => runInstallCommand({ command: npmCommand, args, cwd: worktreePath, env: installEnv, logStream, spawnImpl, timeoutMs });

  logStream.write(`$ ${npmCommand} ${INSTALL_ARGS.join(" ")}\n`);
  const install = await run([...INSTALL_ARGS]);
  record.exitCode = install.exitCode;
  record.signal = install.signal;
  if (install.error || install.timedOut || install.exitCode !== 0) {
    await closeLog();
    const why = install.error ? `could not start: ${install.error}`
      : install.timedOut ? `did not finish within ${timeoutMs}ms and was killed`
      : `exited with code ${install.exitCode}${install.signal ? ` (signal ${install.signal})` : ""}`;
    return finish({ reason: `${npmCommand} ${INSTALL_ARGS.join(" ")} ${why}`, outputTail: outputTail(logPath) });
  }

  for (const name of allowlist) {
    const args = ["rebuild", name, "--foreground-scripts", "--userconfig=/dev/null"];
    logStream.write(`$ ${npmCommand} ${args.join(" ")}\n`);
    const rebuild = await run(args);
    record.installScripts.rebuilds.push({ package: name, args, exitCode: rebuild.exitCode });
    if (rebuild.error || rebuild.timedOut || rebuild.exitCode !== 0) {
      await closeLog();
      return finish({ reason: `allowlisted install script for ${name} failed (${rebuild.error || (rebuild.timedOut ? "timed out" : `exit ${rebuild.exitCode}`)})`, outputTail: outputTail(logPath) });
    }
  }
  await closeLog();

  const after = toolchainStatus(worktreePath, { requireMarker: false, fsImpl });
  record.toolchain.missingAfter = after.missing;
  if (!after.complete) {
    return finish({ reason: `npm ci exited 0 but the toolchain is still incomplete: ${after.reason}`, outputTail: outputTail(logPath) });
  }
  fsImpl.writeFileSync(path.join(worktreePath, INSTALL_MARKER), JSON.stringify({
    lockfileSha256: record.lockfileSha256, commit: record.commit, installedAt: now().toISOString(),
  }, null, 2) + "\n");
  return finish({ ok: true, status: "installed", reason: before.reason });
}

/** The precise blocker text for a failed install, shared by both callers. */
export function dependencyInstallBlockerSections(record, logDir) {
  return [
    `Reason: ${record?.reason || "unknown"}`,
    record?.commit ? `Worktree HEAD: \`${record.commit}\`` : null,
    record?.lockfileSha256 ? `Lockfile SHA-256: \`${record.lockfileSha256}\`` : null,
    `Install record: \`${path.join(logDir, INSTALL_RECORD_FILENAME)}\``,
    record?.outputTail ? ["", "Install output (tail):", "```text", record.outputTail, "```"].join("\n") : null,
    "",
    "No worker was started. Workers have no network for dependency installs, so there is no worker-side fallback, and no sandbox profile was changed. Fix the cause (for example host network or registry access, or a dependency change that needs a human), then requeue the issue.",
  ].filter((line) => line !== null);
}
