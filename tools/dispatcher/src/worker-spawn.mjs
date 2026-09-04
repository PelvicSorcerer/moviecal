// Spawns a worker process against a worktree and captures its output.
//
// The real spawn function is injectable so run-loop logic can be unit
// tested without launching a real `claude`/`codex` process.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * @param {object} opts
 * @param {{command: string, args: string[]}} opts.invocation
 * @param {string} opts.cwd - the worker's worktree path
 * @param {string} opts.brief - text piped to the worker's stdin
 * @param {string} opts.logDir - directory to write stdout.log/stderr.log/manifest.json into
 * @param {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} [opts.spawnImpl]
 * @returns {Promise<{exitCode: number, logDir: string}>}
 */
export function spawnWorker({ invocation, cwd, brief, logDir, spawnImpl = spawn }) {
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, "stdout.log");
  const stderrPath = path.join(logDir, "stderr.log");
  const manifestPath = path.join(logDir, "manifest.json");

  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const child = spawnImpl(invocation.command, invocation.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

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

    child.stdin?.write(brief);
    child.stdin?.end();

    // Both the child process closing AND both log files finishing their
    // writes must happen before we resolve — otherwise a caller that acts on
    // the resolved result (e.g. reading the log tail, or a test's cleanup
    // removing the log directory) can race an in-flight disk write.
    let exitCode = null;
    let settled = false;
    const pending = new Set(["child", "stdout", "stderr"]);

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
