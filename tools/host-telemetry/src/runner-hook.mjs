// Marker construction for the GitHub runner job hooks (MOV-495).
// The runner calls ACTIONS_RUNNER_HOOK_JOB_STARTED / _COMPLETED with the job's
// GITHUB_* environment. A field the hook environment lacks is recorded as null
// and, where possible, recovered from the runner's _diag Worker log.
import fs from "node:fs";
import path from "node:path";
import { emitMarker } from "./emit.mjs";

const ENV_FIELDS = {
  runId: "GITHUB_RUN_ID",
  runAttempt: "GITHUB_RUN_ATTEMPT",
  job: "GITHUB_JOB",
  workflow: "GITHUB_WORKFLOW",
  sha: "GITHUB_SHA",
  ref: "GITHUB_REF",
  repository: "GITHUB_REPOSITORY",
};

const DIAG_TAIL_BYTES = 512 * 1024;

export function diagDirectory(env) {
  if (env.MOVIECAL_RUNNER_DIAG_DIR) return env.MOVIECAL_RUNNER_DIAG_DIR;
  // RUNNER_TEMP is <runner root>/_work/_temp
  return env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, "..", "..", "_diag") : null;
}

/** The newest Worker_*.log tail, or "" when none can be read. */
export function readLatestWorkerLog(dir) {
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((name) => /^Worker_.*\.log$/u.test(name))
      .map((name) => ({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return "";
    const size = fs.statSync(newest.file).size;
    const fd = fs.openSync(newest.file, "r");
    try {
      const length = Math.min(size, DIAG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Run id and result from Worker log text; each is null when not found. */
export function parseWorkerLog(text) {
  const runId =
    /"k":\s*"run_id",\s*"v":\s*"(\d+)"/u.exec(text)?.[1] ?? /\brun_id["':=\s]+(\d{5,})/u.exec(text)?.[1] ?? null;
  const results = [...text.matchAll(/Job .* completed with result: (\w+)/gu)];
  return { runId, result: results.length > 0 ? results.at(-1)[1] : null };
}

/** `fromDiag` lists the fields the Worker log supplied because the hook environment did not. */
export function buildHookFields(kind, env, { readLog = readLatestWorkerLog } = {}) {
  const fields = {};
  for (const [name, variable] of Object.entries(ENV_FIELDS)) fields[name] = env[variable] || null;
  fields.runner = env.RUNNER_NAME || null;
  fields.result = kind === "job-completed" ? env.GITHUB_JOB_STATUS || env.JOB_STATUS || null : undefined;

  const fromDiag = [];
  if (fields.runId === null || (kind === "job-completed" && fields.result === null)) {
    const dir = diagDirectory(env);
    const parsed = dir ? parseWorkerLog(readLog(dir)) : { runId: null, result: null };
    if (fields.runId === null && parsed.runId !== null) {
      fields.runId = parsed.runId;
      fromDiag.push("runId");
    }
    if (kind === "job-completed" && fields.result === null && parsed.result !== null) {
      fields.result = parsed.result;
      fromDiag.push("result");
    }
  }
  if (fields.result === undefined) delete fields.result;
  if (fromDiag.length > 0) fields.fromDiag = fromDiag.join(",");
  return fields;
}

export async function runHook(kind, { env = process.env, ...emitOptions } = {}) {
  try {
    const fields = buildHookFields(kind, env);
    return await emitMarker({ source: "runner", event: kind, ...fields }, { env, wait: true, ...emitOptions });
  } catch {
    return false;
  }
}
