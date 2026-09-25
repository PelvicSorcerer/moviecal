// Spawns a worker process against a worktree and captures its output.
//
// The real spawn function is injectable so run-loop logic can be unit
// tested without launching a real `claude`/`codex` process.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import {
  buildWorkerSandboxProfile,
  guardedInvocation,
  repositoryGuardPaths,
  sanitizedWorkerEnvironment,
} from "./worker-guard.mjs";

const SECRET_KEY_RE = /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|SESSION)/i;

/**
 * Codex's workspace-write sandbox treats linked-worktree Git metadata as
 * outside its workspace. Give it that metadata as an additional directory so
 * it can resolve the worktree's `.git` file. worker-guard.mjs still denies
 * every write to these paths in the inherited Seatbelt profile.
 */
export function withCodexGitMetadataDirectories(invocation, gitMetadataPaths = []) {
  if (path.basename(invocation.command) !== "codex" || gitMetadataPaths.length === 0) return invocation;
  const execIndex = invocation.args.indexOf("exec");
  if (execIndex === -1) throw new Error("Codex worker invocation must include exec before adding Git metadata directories");
  const metadataArgs = gitMetadataPaths.flatMap((metadataPath) => ["--add-dir", metadataPath]);
  return {
    ...invocation,
    args: [...invocation.args.slice(0, execIndex), ...metadataArgs, ...invocation.args.slice(execIndex)],
  };
}

export function redactWorkerOutput(text, { env = process.env } = {}) {
  let redacted = String(text || "");
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_KEY_RE.test(key) || typeof value !== "string" || value.length < 8) continue;
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|lin_api_[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    // A `\b` alone is not enough here: `-` and `_` aren't word characters
    // to `\b` either way, but `_` *is* a `\w` character, so `\b` still fails
    // to separate "TOKEN" from a preceding "_" in "GH_TOKEN" while `-` (as
    // in a hyphenated identifier like "needs-secret") sits on a boundary
    // regardless. Anchor the label's start with a negative lookbehind that
    // excludes any preceding word character *or* hyphen, so a label fused
    // into a larger compound identifier (kebab- or snake-case) is never
    // treated as a standalone credential label. Also exclude a backslash
    // from the captured value: this text is still JSON-encoded at this
    // point (one log line == one JSON event), so a value ending in `\`
    // immediately before an escaped quote would otherwise consume that
    // escape and corrupt the line's JSON structure (MOV-182).
    .replace(/(?<![-\w])((?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)\b\s*[=:]\s*)[^\s\"'\\]+/gi, "$1[REDACTED]");
}

/** One `--input-format stream-json` user-turn frame, plain conversational content only. */
function streamJsonUserMessage(text) {
  return { type: "user", message: { role: "user", content: [{ type: "text", text: String(text ?? "") }] } };
}

/**
 * MOV-166/214-215: parse newline-delimited JSON out of a Claude worker's
 * `--output-format stream-json` stdout, calling `onTurnComplete` for each
 * `{"type":"result", ...}` line -- the event that marks one turn finished.
 * This is a read-only tap: it never consumes bytes the existing
 * log/redaction pipeline also needs, and a non-JSON or partial line is
 * silently ignored rather than treated as an error (worker output is not a
 * contract this dispatcher controls).
 */
function makeTurnBoundaryParser(onTurnComplete) {
  let carry = "";
  return (chunk) => {
    carry += chunk.toString("utf8");
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === "object" && parsed.type === "result") onTurnComplete();
    }
  };
}

/** Count live model responses without a CLI turn-limit flag or transcript reread. */
export function makeAssistantTurnCounter(worker, onTurn) {
  let carry = "";
  let turns = 0;
  const seen = new Set();
  return (chunk) => {
    carry += chunk.toString("utf8");
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (worker === "claude" && event?.type === "assistant" && event.message?.role === "assistant") {
        const id = event.message.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
      } else if (!(worker === "codex" && event?.type === "turn.completed")) {
        continue;
      }
      turns += 1;
      onTurn(turns);
    }
  };
}

function redactionStream(env) {
  let carry = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      const parts = (carry + chunk.toString("utf8")).split("\n");
      carry = parts.pop() || "";
      for (const line of parts) this.push(redactWorkerOutput(line, { env }) + "\n");
      callback();
    },
    flush(callback) {
      if (carry) this.push(redactWorkerOutput(carry, { env }));
      callback();
    },
  });
}

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
 * @param {(worker: {pid: number|null}) => void} [opts.onSpawn] - called after the detached worker process group is created and before its brief is written; callers use this to durably record the group leader for crash recovery
 * @param {AbortSignal} [opts.signal] - MOV-138: aborting (e.g. a per-worker timeout in run-loop.mjs) reaps the
 *   worker's process group immediately, the same SIGTERM-then-SIGKILL path used once the worker exits on its own
 *   (MOV-137). The promise still only settles once the child actually closes.
 * @param {{mode?: 'implementation'|'repair'}} [opts.securityContext] - when present, enforce the shared MOV-145 guard
 * @param {NodeJS.Platform} [opts.platform] - injectable for tests
 * @param {(cwd: string) => {protectedRepositoryPaths: string[], gitMetadataPaths: string[]}} [opts.repositoryGuardPathsFn] - injectable for tests
 * @param {boolean} [opts.steering] - MOV-214/215: when true (Claude only; the invocation must already carry
 *   `--input-format stream-json`, see worker-routing.mjs), keep stdin open after the initial brief instead of
 *   closing it, and return `{promise, writeTurn, requestClose, nextTurnBoundary}` instead of a bare `Promise` --
 *   `promise` still resolves exactly as it does today. Off by default: every existing caller and every non-Claude
 *   worker gets today's exact bare-Promise behavior with stdin closed after the brief, byte-for-byte.
 * @param {string} [opts.iosSimLeaseId] - MOV-311: the dispatcher's already-held worker-lane iOS simulator lease id
 *   (an "iOS Companion App" issue only), added to the sanitized worker environment as MOVIECAL_IOS_SIM_LEASE_ID so
 *   a nested `ios:sim:run` inside the worker recognizes and renews it instead of queueing behind its own dispatcher.
 *   Only ever applied inside the sandboxed (securityContext) branch -- there is no unsandboxed production path.
 * @returns {Promise<{exitCode: number, logDir: string, pid: number|null}>|{promise: Promise<{exitCode: number, logDir: string, pid: number|null}>, writeTurn: (text: string) => void, requestClose: () => void, nextTurnBoundary: () => Promise<{ended: boolean}>}}
 */
export function spawnWorker({
  invocation,
  cwd,
  brief,
  logDir,
  spawnImpl = spawn,
  killGraceMs = 5000,
  killImpl = killProcessGroup,
  onSpawn = () => {},
  signal,
  securityContext,
  platform = process.platform,
  repositoryGuardPathsFn = repositoryGuardPaths,
  steering = false,
  iosSimLeaseId = null,
  onAssistantTurn = null,
}) {
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutPath = path.join(logDir, "stdout.log");
  const stderrPath = path.join(logDir, "stderr.log");
  const manifestPath = path.join(logDir, "manifest.json");

  // Hoisted so writeTurn/requestClose/nextTurnBoundary (built after the
  // promise below, steering-only) can reach the live child and its turn
  // state. `child` stays undefined if the executor rejects before spawning
  // (e.g. the darwin-only security-sandbox check) -- every steering helper
  // guards for that.
  let child;
  let childClosed = false;
  let pendingTurns = 0;
  const turnWaiters = [];

  const promise = new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    let effectiveInvocation = invocation;
    let workerEnv = process.env;
    if (securityContext) {
      if (platform !== "darwin") {
        childClosed = true; // no child will ever spawn; nextTurnBoundary() must not hang
        reject(new Error(`worker safety sandbox is only supported on darwin (got ${platform})`));
        return;
      }
      let repositoryPaths;
      try {
        repositoryPaths = repositoryGuardPathsFn(cwd);
      } catch (err) {
        childClosed = true;
        reject(new Error(`worker safety sandbox could not resolve repository boundaries: ${err.message}`));
        return;
      }
      const profilePath = path.join(logDir, "worker-sandbox.sb");
      const profile = buildWorkerSandboxProfile({
        worktreePath: cwd,
        mode: securityContext.mode || "implementation",
        logDir,
        ...repositoryPaths,
      });
      fs.writeFileSync(profilePath, profile, { mode: 0o600 });
      effectiveInvocation = guardedInvocation(
        withCodexGitMetadataDirectories(invocation, repositoryPaths.gitMetadataPaths),
        { profilePath },
      );
      workerEnv = sanitizedWorkerEnvironment(process.env, {
        worker: path.basename(invocation.command),
      });
      if (iosSimLeaseId) workerEnv.MOVIECAL_IOS_SIM_LEASE_ID = iosSimLeaseId;
    }
    // detached: true (POSIX) makes the child the leader of its own process
    // group via setsid(), so its own pid doubles as the group id we reap on
    // exit — any grandchildren it backgrounds (xcodebuild, simctl, npm, ...)
    // are in that same group and go down with it.
    child = spawnImpl(effectiveInvocation.command, effectiveInvocation.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: workerEnv,
    });

    // Persist the detached group leader before giving the worker its brief.
    // If the dispatcher dies later, startup recovery can kill this exact
    // group before it ever reuses the worktree (MOV-254). A failed durable
    // handoff is fail-closed: do not allow an untracked worker to run.
    try {
      onSpawn({ pid: child.pid || null });
    } catch (err) {
      killImpl(child.pid, "SIGKILL");
      childClosed = true;
      reject(err);
      return;
    }

    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);
    // A write stream with no 'error' listener turns any internal fs error
    // (disk full, log dir removed out from under it, etc.) into an uncaught
    // exception rather than something this function can react to. Swallow it
    // here — a failed log write must never crash the dispatcher process; the
    // worker's own exit code is still the source of truth for success/failure.
    stdoutStream.on("error", () => {});
    stderrStream.on("error", () => {});
    child.stdout?.pipe(redactionStream(process.env)).pipe(stdoutStream);
    child.stderr?.pipe(redactionStream(process.env)).pipe(stderrStream);
    if (onAssistantTurn) {
      child.stdout?.on("data", makeAssistantTurnCounter(path.basename(invocation.command), onAssistantTurn));
    }
    if (steering) {
      // A second, independent listener on the same readable -- Node
      // broadcasts every chunk to all attached 'data' listeners, so this
      // never competes with or alters what the pipe above logs.
      child.stdout?.on(
        "data",
        makeTurnBoundaryParser(() => {
          const waiter = turnWaiters.shift();
          if (waiter) waiter({ ended: false });
          else pendingTurns += 1;
        }),
      );
    }

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
        if (child.stdin.writable) {
          // MOV-214/215: with steering active the brief is the *first turn*
          // of an interactive stream-json session, not a one-shot text blob
          // -- and stdin stays open afterward so a later trusted prompt can
          // be written as a subsequent turn (see writeTurn/requestClose
          // below). Without steering this is byte-for-byte today's behavior.
          child.stdin.write(steering ? `${JSON.stringify(streamJsonUserMessage(brief))}\n` : brief);
        }
        if (!steering) child.stdin.end();
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
          {
            command: invocation.command,
            args: invocation.args,
            cwd,
            startedAt,
            endedAt,
            exitCode,
            securityGuard: securityContext ? { enforced: true, mode: securityContext.mode || "implementation" } : { enforced: false },
          },
          null,
          2,
        ) + "\n",
      );
      resolve({ exitCode: exitCode ?? 1, logDir, pid: child.pid || null });
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
      childClosed = true;
      while (turnWaiters.length) turnWaiters.shift()({ ended: true });
      stdoutStream.destroy();
      stderrStream.destroy();
      reject(err);
    });
    child.on("close", (code) => {
      exitCode = code;
      childClosed = true;
      while (turnWaiters.length) turnWaiters.shift()({ ended: true });
      pending.delete("child");
      reapProcessGroup(child.pid, { graceMs: killGraceMs, killImpl }).then(() => {
        pending.delete("reap");
        maybeFinish();
      });
      maybeFinish();
    });
  });

  if (!steering) return promise;

  return {
    promise,
    /** Write one trusted follow-up prompt as the next turn. A no-op (not a throw) once the process is gone or never started. */
    writeTurn(text) {
      if (!child || !child.stdin || !child.stdin.writable) return;
      try {
        child.stdin.write(`${JSON.stringify(streamJsonUserMessage(text))}\n`);
      } catch (err) {
        if (!err || err.code !== "EPIPE") throw err;
      }
    },
    /** No more turns are coming for this attempt: close stdin so the worker's own interactive session ends. */
    requestClose() {
      if (!child || !child.stdin || !child.stdin.writable) return;
      try {
        child.stdin.end();
      } catch (err) {
        if (!err || err.code !== "EPIPE") throw err;
      }
    },
    /** Resolves once the worker's current turn completes, or immediately with `{ended: true}` if it has already exited. */
    nextTurnBoundary() {
      if (pendingTurns > 0) {
        pendingTurns -= 1;
        return Promise.resolve({ ended: false });
      }
      if (childClosed) return Promise.resolve({ ended: true });
      return new Promise((resolve) => turnWaiters.push(resolve));
    },
  };
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
