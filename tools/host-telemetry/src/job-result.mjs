// Deferred job-result lookup (MOV-495). The runner runs the job-completed hook
// BEFORE it knows the job result: in a real run the hook ran at 01:27:45, the
// Worker log recorded the result at 01:27:46 and Runner_*.log recorded
// "completed with result" at 01:27:48, and the runner sets no GITHUB_JOB_STATUS
// for hooks. So the hook cannot report the result itself. Instead it spawns
// bin/resolve-job-result.mjs detached; that process waits, reads the runner's
// _diag logs (Runner_*.log first, Worker_*.log second) and writes a separate
// `job-result` marker. Everything here is best effort and never throws.
import fs from "node:fs";
import path from "node:path";

export const RESULT_INITIAL_WAIT_MS = 10_000;
export const RESULT_RETRY_INTERVAL_MS = 2_000;
export const RESULT_MAX_WAIT_MS = 30_000;
export const RESULT_TAIL_BYTES = 512 * 1024;
// Log timestamps are second-resolution and the runner's clock is the same host's,
// but allow a little slack so a result written in the same second still counts.
export const RESULT_CLOCK_SLACK_MS = 2_000;

const RESULT_LINE = /^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?\]?.*?\bJob\b.*\bcompleted with result: (\w+)/u;
const ANY_RESULT_LINE = /\bJob\b.*\bcompleted with result: (\w+)/u;

/**
 * Result lines in log text, oldest first: { result, atMs } where atMs is the
 * line's own UTC timestamp or null when the line has none.
 */
export function parseResultLines(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const stamped = RESULT_LINE.exec(line);
    if (stamped) {
      const atMs = Date.parse(`${stamped[1]}T${stamped[2]}Z`);
      out.push({ result: stamped[3], atMs: Number.isNaN(atMs) ? null : atMs });
      continue;
    }
    const bare = ANY_RESULT_LINE.exec(line);
    if (bare) out.push({ result: bare[1], atMs: null });
  }
  return out;
}

/**
 * The result for the job whose hook started at `sinceMs`: the LAST result line
 * stamped at or after sinceMs (minus slack). A line without a timestamp counts
 * only when `fileMtimeMs` shows the file was written after sinceMs. Lines
 * stamped before the hook belong to earlier jobs and are ignored. Null if none.
 */
export function pickResult(text, { sinceMs, fileMtimeMs = null }) {
  const floor = sinceMs - RESULT_CLOCK_SLACK_MS;
  const candidates = parseResultLines(text).filter((line) =>
    line.atMs !== null ? line.atMs >= floor : fileMtimeMs !== null && fileMtimeMs >= floor,
  );
  return candidates.length > 0 ? candidates.at(-1).result : null;
}

function readTail(file, size) {
  const fd = fs.openSync(file, "r");
  try {
    const length = Math.min(size, RESULT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Log files in `dir` named <prefix>_*.log, newest first, each { text, mtimeMs }. Unreadable ones are skipped. */
export function readLogs(dir, prefix, { sinceMs = 0 } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const logs = [];
  for (const name of names) {
    if (!name.startsWith(`${prefix}_`) || !name.endsWith(".log")) continue;
    try {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.mtimeMs < sinceMs - RESULT_CLOCK_SLACK_MS) continue;
      logs.push({ text: readTail(file, stat.size), mtimeMs: stat.mtimeMs });
    } catch {
      // vanished or unreadable: skip
    }
  }
  return logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** One lookup pass: Runner logs first, then Worker logs. { result, source } with nulls when nothing matched. */
export function lookupResult(dir, sinceMs) {
  for (const [prefix, source] of [["Runner", "runner-log"], ["Worker", "worker-log"]]) {
    for (const log of readLogs(dir, prefix, { sinceMs })) {
      const result = pickResult(log.text, { sinceMs, fileMtimeMs: log.mtimeMs });
      if (result !== null) return { result, source };
    }
  }
  return { result: null, source: null };
}

/**
 * Wait `initialWaitMs`, then look up the result, retrying every `intervalMs`
 * until found or `maxWaitMs` (measured from the call) has passed. Injectable
 * `sleep`/`now`/`lookup` keep tests instant. Never throws.
 */
export async function resolveJobResult({
  dir,
  sinceMs,
  initialWaitMs = RESULT_INITIAL_WAIT_MS,
  intervalMs = RESULT_RETRY_INTERVAL_MS,
  maxWaitMs = RESULT_MAX_WAIT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  lookup = lookupResult,
}) {
  const started = now();
  let found = { result: null, source: null };
  let attempts = 0;
  try {
    if (!dir) return { ...found, attempts, waitedMs: 0 };
    await sleep(Math.min(initialWaitMs, maxWaitMs));
    for (;;) {
      attempts += 1;
      found = lookup(dir, sinceMs);
      if (found.result !== null) break;
      const elapsed = now() - started;
      if (elapsed + intervalMs > maxWaitMs) break;
      await sleep(intervalMs);
    }
  } catch {
    // fall through with whatever was found
  }
  return { ...found, attempts, waitedMs: Math.max(0, now() - started) };
}
