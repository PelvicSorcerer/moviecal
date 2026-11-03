#!/usr/bin/env node
// Detached job-result reader spawned by hooks/job-completed (MOV-495).
// argv[2] is JSON: { fields: {runId, job, ...}, dir (telemetry), diagDir, sinceMs, options? }.
// Waits, reads the runner _diag logs and writes a `job-result` marker. Always exits 0.
import { appendMarker } from "../src/markers.mjs";
import { resolveJobResult } from "../src/job-result.mjs";

try {
  const { fields, dir, diagDir, sinceMs, options = {} } = JSON.parse(process.argv[2]);
  const found = await resolveJobResult({ dir: diagDir, sinceMs, ...options });
  appendMarker(
    { source: "runner", event: "job-result", ...fields, result: found.result, resultSource: found.source, attempts: found.attempts, waitedMs: found.waitedMs },
    { dir },
  );
} catch {
  // telemetry must never matter to anything
}
process.exitCode = 0;
