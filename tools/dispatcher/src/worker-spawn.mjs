// Spawns a worker process against a worktree and captures its output.
//
// The real spawn function is injectable so run-loop logic can be unit
// tested without launching a real `claude`/`codex` process.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Signal a worker's whole process group (negative pid), swallowing the
 * "already gone" case. Only meaningful when the child was spawned detached
 * (see spawnWorker) so its pid is also its process-group id.
 */
function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // process group already gone
  }
}

/**
 * MOV-137: a worker (`claude -p` / `codex exec`) is one-shot — if it
 * backgrounds a long-running build/test and exits, that child has no parent
 * left to wait on it. Reap the worker's entire process group after it exits
 * so nothing it spawned (xcodebuild, simctl, npm, ...) outlives it: SIGTERM
 * first, then SIGKILL after a grace period, both idempotent against an
 * already-empty group.
 */
function reapProcessGroup(pid, { graceMs, killImpl }) {
  if (!pid) return Promise.resolve();
  killImpl(pid, "SIGTERM");
  return new Promise((resolve) => {
    setTimeout(() => {
      killImpl(pid, "SIGKILL");
      resolve();
    }, graceMs);
  });
}

/**
 * @param {object} opts
 * @param {{command: string, args: string[]}} opts.invocation
 * @param {string} opts.cwd - the worker's worktree path
 * @param {string} opts.brief - text piped to the worker's stdin
 * @param {string} opts.logDir - directory to write stdout.log/stderr.log/manifest.json into
 * @param {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} [opts.spawnImpl]
 * @param {number} [opts.killGraceMs] - delay between SIGTERM and SIGKILL when reaping the worker's process group
 * @param {(pid: number, signal: string) => void} [opts.killImpl] - injectable for tests; defaults to signalling the real process group
 * @param {AbortSignal} [opts.signal] - MOV-138: aborting (e.g. a per-worker timeout in run-loop.mjs) reaps the
 *   worker's process group immediately, the same SIGTERM-then-SIGKILL path used once the worker exits on its own
 *   (MOV-137). The promise still only settles once the child actually closes.
 * @returns {Promise<{exitCode: number, logDir: string}>}
 */
export function spawnWorker({
  invocation,
  cwd,
  brief,
  logDir,
  spawnImpl = spawn,
  killGraceMs = 5000,
  killImpl = killProcessGroup,
  signal,
}) {
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, "stdout.log");
  const stderrPath = path.join(logDir, "stderr.log");
  const manifestPath = path.join(logDir, "manifest.json");

  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    // detached: true (POSIX) makes the child the leader of its own process
    // group via setsid(), so its own pid doubles as the group id we reap on
    // exit — any grandchildren it backgrounds (xcodebuild, simctl, npm, ...)
    // are in that same group and go down with it.
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);
    // A write stream with no 'error' listener turns any internal fs error
    // (disk full, log dir removed out from under it, etc.) into an uncaught
    // exception rather than something this function can react to. Swallow it
    // here — a failed log write must never crash the dispatcher process; the
    // worker's own exit code is still the source of truth for success/failure.
    stdoutStream.on("error", () => {});
    stderrStream.on("error", () => {});
    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);

    if (signal) {
      const killOnAbort = () => reapProcessGroup(child.pid, { graceMs: killGraceMs, killImpl });
      if (signal.aborted) killOnAbort();
      else signal.addEventListener("abort", killOnAbort, { once: true });
    }

    // A worker that dies immediately (crash on startup, killed before it ever
    // reads stdin) closes its stdin pipe, so writing the brief races the exit
    // and can raise an async EPIPE. Without an 'error' listener that becomes an
    // unhandled exception. The brief is only useful to a live worker, so a
    // broken pipe here is benign — swallow EPIPE, and re-surface anything else.
    if (child.stdin) {
      child.stdin.on("error", (err) => {
        if (err && err.code === "EPIPE") return;
        throw err;
      });
      try {
        if (child.stdin.writable) child.stdin.write(brief);
        child.stdin.end();
      } catch (err) {
        if (!err || err.code !== "EPIPE") throw err;
      }
    }

    // Both the child process closing AND both log files finishing their
    // writes must happen before we resolve — otherwise a caller that acts on
    // the resolved result (e.g. reading the log tail, or a test's cleanup
    // removing the log directory) can race an in-flight disk write.
    let exitCode = null;
    let settled = false;
    const pending = new Set(["child", "stdout", "stderr", "reap"]);

    const maybeFinish = () => {
      if (pending.size > 0 || settled) return;
      settled = true;
      const endedAt = new Date().toISOString();
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          { command: invocation.command, args: invocation.args, cwd, startedAt, endedAt, exitCode },
          null,
          2,
        ) + "\n",
      );
      resolve({ exitCode: exitCode ?? 1, logDir });
    };

    stdoutStream.on("finish", () => {
      pending.delete("stdout");
      maybeFinish();
    });
    stderrStream.on("finish", () => {
      pending.delete("stderr");
      maybeFinish();
    });

    child.on("error", (err) => {
      settled = true;
      stdoutStream.destroy();
      stderrStream.destroy();
      reject(err);
    });
    child.on("close", (code) => {
      exitCode = code;
      pending.delete("child");
      reapProcessGroup(child.pid, { graceMs: killGraceMs, killImpl }).then(() => {
        pending.delete("reap");
        maybeFinish();
      });
      maybeFinish();
    });
  });
}

/** Read the last `n` lines across stdout+stderr logs for a failed run, for reporting back to Linear. */
export function tailLogs(logDir, n = 50) {
  const parts = [];
  for (const file of ["stdout.log", "stderr.log"]) {
    const full = path.join(logDir, file);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, "utf8").split("\n");
    parts.push(`--- ${file} (last ${n} lines) ---`, ...lines.slice(-n));
  }
  return parts.join("\n");
}
