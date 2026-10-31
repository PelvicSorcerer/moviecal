import fs from "node:fs";
import path from "node:path";

// MOV-491: scheduling for the in-daemon worktree gc pass (MOV-447). Pure
// decisions only; the caller owns the lock, the clock and the gc itself.

export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Read the schedule from the environment.
 *   MOVIECAL_GC_SCHEDULED  "0"/"false"/"off"/"no" disables; unset/""/"1"/"true"/"on"/"yes" enables.
 *                          Anything else fails closed (disabled) so a typo never deletes unattended.
 *   MOVIECAL_GC_HOUR       optional local hour 0-23; an invalid value falls back to the 24h interval.
 */
export function resolveGcSchedule(env = process.env) {
  const warnings = [];
  const scheduled = String(env.MOVIECAL_GC_SCHEDULED ?? "").trim().toLowerCase();
  let enabled = true;
  if (["0", "false", "off", "no"].includes(scheduled)) enabled = false;
  else if (!["", "1", "true", "on", "yes"].includes(scheduled)) {
    enabled = false;
    warnings.push(`MOVIECAL_GC_SCHEDULED="${env.MOVIECAL_GC_SCHEDULED}" is not recognised; scheduled gc is disabled`);
  }

  let hour = null;
  const rawHour = String(env.MOVIECAL_GC_HOUR ?? "").trim();
  if (rawHour !== "") {
    const n = Number(rawHour);
    if (Number.isInteger(n) && n >= 0 && n <= 23) hour = n;
    else warnings.push(`MOVIECAL_GC_HOUR="${env.MOVIECAL_GC_HOUR}" is not an integer 0-23; using the ${GC_INTERVAL_MS / 3_600_000}h interval`);
  }
  return { enabled, hour, warnings };
}

function localDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Should a scheduled pass start now? `lastRunAt` is the epoch ms of the last
 * attempt this process made (0 / null when none). With an hour configured it
 * runs at most once per local day, at or after that hour; otherwise at most
 * once per interval.
 */
export function shouldRunScheduledGc({ schedule, now = new Date(), lastRunAt = 0 }) {
  if (!schedule?.enabled) return false;
  if (schedule.hour === null || schedule.hour === undefined) {
    return now.getTime() - (lastRunAt || 0) >= GC_INTERVAL_MS;
  }
  if (now.getHours() < schedule.hour) return false;
  return !lastRunAt || localDayKey(new Date(lastRunAt)) !== localDayKey(now);
}

export function gcLogPath(logRootDir) {
  return path.join(logRootDir, "worktree-gc.log");
}

/** One JSON line per scheduled pass, so every candidate result is recoverable. */
export function formatGcLogRecord({ at = new Date(), exitCode, retentionDays, results = [], error = null }) {
  return `${JSON.stringify({ at: at.toISOString(), exitCode, retentionDays, error, results })}\n`;
}

export function appendGcLog(logRootDir, record) {
  fs.mkdirSync(logRootDir, { recursive: true });
  fs.appendFileSync(gcLogPath(logRootDir), record, { mode: 0o600 });
}
