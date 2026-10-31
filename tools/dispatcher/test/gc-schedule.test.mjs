import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveGcSchedule, shouldRunScheduledGc, formatGcLogRecord, appendGcLog, gcLogPath, GC_INTERVAL_MS,
} from "../src/gc-schedule.mjs";

const at = (iso) => new Date(iso);

describe("resolveGcSchedule", () => {
  it("defaults to enabled on the 24h interval", () => {
    expect(resolveGcSchedule({})).toEqual({ enabled: true, hour: null, warnings: [] });
    expect(resolveGcSchedule({ MOVIECAL_GC_SCHEDULED: "1" }).enabled).toBe(true);
  });
  it("disables on explicit off values", () => {
    for (const v of ["0", "false", "OFF", "no"]) expect(resolveGcSchedule({ MOVIECAL_GC_SCHEDULED: v }).enabled).toBe(false);
  });
  it("fails closed on an unrecognised value", () => {
    const s = resolveGcSchedule({ MOVIECAL_GC_SCHEDULED: "maybe" });
    expect(s.enabled).toBe(false);
    expect(s.warnings[0]).toMatch(/not recognised/);
  });
  it("parses a valid hour including 0", () => {
    expect(resolveGcSchedule({ MOVIECAL_GC_HOUR: "3" }).hour).toBe(3);
    expect(resolveGcSchedule({ MOVIECAL_GC_HOUR: "0" }).hour).toBe(0);
  });
  it("falls back to the interval with a warning on an invalid hour", () => {
    for (const v of ["24", "-1", "2.5", "abc"]) {
      const s = resolveGcSchedule({ MOVIECAL_GC_HOUR: v });
      expect(s.hour).toBeNull();
      expect(s.enabled).toBe(true);
      expect(s.warnings[0]).toMatch(/MOVIECAL_GC_HOUR/);
    }
  });
});

describe("shouldRunScheduledGc", () => {
  const interval = { enabled: true, hour: null };
  it("never runs when disabled", () => {
    expect(shouldRunScheduledGc({ schedule: { enabled: false, hour: null }, now: at("2026-10-31T12:00:00"), lastRunAt: 0 })).toBe(false);
  });
  it("interval mode: first eligible poll runs, then waits 24h", () => {
    const now = at("2026-10-31T12:00:00");
    expect(shouldRunScheduledGc({ schedule: interval, now, lastRunAt: 0 })).toBe(true);
    expect(shouldRunScheduledGc({ schedule: interval, now, lastRunAt: now.getTime() - GC_INTERVAL_MS + 1 })).toBe(false);
    expect(shouldRunScheduledGc({ schedule: interval, now, lastRunAt: now.getTime() - GC_INTERVAL_MS })).toBe(true);
  });
  it("hour mode: waits for the hour, then runs once per local day", () => {
    const schedule = { enabled: true, hour: 3 };
    expect(shouldRunScheduledGc({ schedule, now: at("2026-10-31T02:59:00"), lastRunAt: 0 })).toBe(false);
    expect(shouldRunScheduledGc({ schedule, now: at("2026-10-31T03:00:00"), lastRunAt: 0 })).toBe(true);
    const ran = at("2026-10-31T03:01:00").getTime();
    expect(shouldRunScheduledGc({ schedule, now: at("2026-10-31T15:00:00"), lastRunAt: ran })).toBe(false);
    expect(shouldRunScheduledGc({ schedule, now: at("2026-11-01T02:00:00"), lastRunAt: ran })).toBe(false);
    expect(shouldRunScheduledGc({ schedule, now: at("2026-11-01T03:00:00"), lastRunAt: ran })).toBe(true);
  });
  it("hour mode tolerates a skipped day (runs once, not twice)", () => {
    const schedule = { enabled: true, hour: 3 };
    const ran = at("2026-10-28T03:01:00").getTime();
    expect(shouldRunScheduledGc({ schedule, now: at("2026-10-31T09:00:00"), lastRunAt: ran })).toBe(true);
  });
});

describe("worktree-gc.log", () => {
  it("appends one parseable JSON line per pass with every result", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-log-"));
    try {
      const results = [{ outcome: "removed", code: "removed" }, { outcome: "retained", until: "2026-11-05" }];
      appendGcLog(dir, formatGcLogRecord({ at: at("2026-10-31T03:00:00Z"), exitCode: 0, retentionDays: 7, results }));
      appendGcLog(dir, formatGcLogRecord({ at: at("2026-11-01T03:00:00Z"), exitCode: 1, retentionDays: 7, error: "boom" }));
      const lines = fs.readFileSync(gcLogPath(dir), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ at: "2026-10-31T03:00:00.000Z", exitCode: 0, retentionDays: 7, error: null, results });
      expect(lines[1]).toMatchObject({ exitCode: 1, error: "boom", results: [] });
      expect(fs.statSync(gcLogPath(dir)).mode & 0o777).toBe(0o600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
