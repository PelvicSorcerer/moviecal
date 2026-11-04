#!/usr/bin/env node
// Per-run telemetry report. MOV-496.
//   report.mjs --run <run id> | --since <30m|2h|1d> | --from <iso> --to <iso>
//              [--summary] [--status <job status>] [--dir <telemetry dir>] [--reports-dir <dir>]... [--diag-dir <dir>]
// --summary prints short Markdown for $GITHUB_STEP_SUMMARY and always exits 0.
import { pathToFileURL } from "node:url";
import { ADMIN_REMINDER, telemetryDir } from "../src/common.mjs";
import { DEFAULT_REPORT_DIRS, buildReport, parseDuration } from "../src/report.mjs";
import { renderFull, renderSummary, renderUnavailable } from "../src/report-render.mjs";
import { diagDirectory } from "../src/runner-hook.mjs";

function parseArgs(argv) {
  const opts = { reportDirs: [] };
  const value = (i) => {
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--summary") opts.summary = true;
    else if (a === "--run") opts.runId = value(i++);
    else if (a === "--since") opts.sinceMs = parseDuration(value(i++));
    else if (a === "--from" || a === "--to") {
      const t = Date.parse(value(i));
      if (Number.isNaN(t)) throw new Error(`${a} needs an ISO timestamp`);
      opts[a === "--from" ? "fromMs" : "toMs"] = t;
      i += 1;
    } else if (a === "--status") opts.status = value(i++);
    else if (a === "--dir") opts.dir = value(i++);
    else if (a === "--reports-dir") opts.reportDirs.push(value(i++));
    else if (a === "--diag-dir") opts.diagDir = value(i++);
    else if (a === "--now") opts.nowMs = Date.parse(value(i++));
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export function main(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (argv.includes("--summary")) {
      out(renderUnavailable(error.message));
      return 0;
    }
    err(error.message);
    return 2;
  }
  try {
    const report = buildReport({
      dir: opts.dir ?? telemetryDir(env),
      runId: opts.runId ?? null,
      sinceMs: opts.sinceMs ?? null,
      fromMs: opts.fromMs ?? null,
      toMs: opts.toMs ?? null,
      nowMs: opts.nowMs ?? Date.now(),
      reportDirs: opts.reportDirs.length ? opts.reportDirs : DEFAULT_REPORT_DIRS,
      diagDir: opts.diagDir ?? diagDirectory(env),
      status: opts.status ?? null,
    });
    if (report.error) {
      if (opts.summary) out(renderUnavailable(report.error));
      else err(`${report.error}\n${ADMIN_REMINDER}`);
      return opts.summary ? 0 : 1;
    }
    out(opts.summary ? renderSummary(report) : renderFull(report));
    return 0;
  } catch (error) {
    if (opts.summary) {
      out(renderUnavailable(`report failed (${error.message})`));
      return 0;
    }
    err(`report failed: ${error.stack ?? error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
