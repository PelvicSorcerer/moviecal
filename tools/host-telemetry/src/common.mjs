// Shared constants and path helpers for the host telemetry sampler (MOV-494).
import os from "node:os";
import path from "node:path";

export const ADMIN_REMINDER =
  "Admin-level collection (powermetrics, spindump) is NOT enabled. If load problems persist after reviewing this data, ask Adam to consider enabling it.";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function telemetryDir(env = process.env) {
  return env.MOVIECAL_TELEMETRY_DIR || path.join(os.homedir(), "Library", "Logs", "moviecal-telemetry");
}

export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function headerLine(kind) {
  return JSON.stringify({ header: true, kind, schema: 1, note: ADMIN_REMINDER });
}
