import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSpans, computeBaseline, findGaps, findOverlaps, findResult, groupTotals, loadNoJobIntervals, parseDuration,
  readSamples, resolveWindow, wedgeIncidents, windowStats,
} from "../src/report.mjs";
import { ADMIN_REMINDER } from "../src/common.mjs";
import { likelyCauseLine, noJobLine, renderSummary, wedgeLine } from "../src/report-render.mjs";
import { T, marker, sample, series, tmpRoot, writeJsonl } from "./report-fixture.mjs";

describe("window selection", () => {
  const markers = [
    marker("12:00:00", "runner", "job-started", { runId: "7", runAttempt: "1" }),
    marker("12:05:00", "runner", "job-completed", { runId: "7", runAttempt: "1" }),
    marker("12:10:00", "runner", "job-started", { runId: "8", runAttempt: "1" }),
  ];
  it("selects a finished run by its markers", () => {
    expect(resolveWindow({ markers, runId: "7", nowMs: T("13:00:00") })).toMatchObject({ startMs: T("12:00:00"), endMs: T("12:05:00"), open: false });
  });
  it("leaves an unfinished run open until now", () => {
    expect(resolveWindow({ markers, runId: "8", nowMs: T("12:12:00") })).toMatchObject({ startMs: T("12:10:00"), endMs: T("12:12:00"), open: true });
  });
  it("reports an unknown run, and supports --since and --from/--to", () => {
    expect(resolveWindow({ markers, runId: "99", nowMs: 0 }).error).toMatch(/no telemetry markers for run 99/);
    expect(resolveWindow({ markers: [], sinceMs: parseDuration("30m"), nowMs: T("12:30:00") })).toMatchObject({ startMs: T("12:00:00"), endMs: T("12:30:00") });
    expect(resolveWindow({ markers: [], fromMs: 1, toMs: 5, nowMs: 9 })).toMatchObject({ startMs: 1, endMs: 5 });
    expect(resolveWindow({ markers: [], nowMs: 9 }).error).toMatch(/--run/);
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("gap detection", () => {
  it("marks intervals over 3x cadence, using the busy cadence after a busy sample", () => {
    const idle = series(T("12:00:00"), T("12:00:30"), 5000, (t) => sample(t));
    expect(findGaps(idle, T("12:00:00"), T("12:00:30"))).toEqual([]);
    const busy = [sample(T("12:00:00"), { busy: true }), sample(T("12:00:04"), { busy: true }), sample(T("12:00:10"), { busy: true })];
    const gaps = findGaps(busy, T("12:00:00"), T("12:00:10"));
    expect(gaps).toEqual([{ fromMs: T("12:00:04"), toMs: T("12:00:10"), durationMs: 6000 }]);
    const idleGap = [sample(T("12:00:00")), sample(T("12:00:16"))];
    expect(findGaps(idleGap, T("12:00:00"), T("12:00:16"))).toHaveLength(1);
  });
  it("marks a window with no samples and an unsampled tail", () => {
    expect(findGaps([], 0, 60_000)[0]).toMatchObject({ noSamples: true });
    expect(findGaps([sample(T("12:00:00"))], T("12:00:00"), T("12:01:00"))).toHaveLength(1);
  });
});

describe("statistics and groups", () => {
  it("computes peak/avg pressure, swap change, load, thermal and disk", () => {
    const stats = windowStats([
      sample(T("12:00:00"), { pressure: 1, swapUsedMb: 100, load: [2, 0, 0], diskFreeGb: 30, thermal: { speedLimit: 100 } }),
      sample(T("12:00:05"), { pressure: 2, swapUsedMb: 160, load: [6, 0, 0], diskFreeGb: 20, thermal: { speedLimit: 80 } }),
      sample(T("12:00:10"), { pressure: null, swapUsedMb: null, load: [4, 0, 0] }),
    ]);
    expect(stats.pressure).toEqual({ peak: 2, avg: 1.5 });
    expect(stats.swap).toMatchObject({ change: 60, peak: 160 });
    expect(stats.load).toMatchObject({ peak: 6, avg: 4 });
    expect(stats.thermalMinSpeedLimit).toBe(80);
    expect(stats.diskFreeMinGb).toBe(20);
  });
  it("integrates CPU-seconds, tracks peak RSS and skips samples without ps data", () => {
    const g = (cpu, rssMb) => ({ ...sample(0).groups, xcode: { count: 1, cpu, rssMb } });
    const { totals, psMissing } = groupTotals([
      sample(T("12:00:00"), { groups: g(100, 500) }),
      sample(T("12:00:05"), { groups: g(50, 900) }),
      sample(T("12:00:10"), { groups: null, runnable: null }),
      sample(T("12:00:15"), { groups: g(10, 100) }),
    ]);
    expect(totals.xcode.cpuSeconds).toBe(7.5);
    expect(totals.xcode.peakRssMb).toBe(900);
    expect(psMissing).toBe(1);
  });
});

describe("overlaps", () => {
  it("finds CI, simulator and worker overlaps and ignores the run's own spans", () => {
    const spans = buildSpans(
      [
        marker("12:00:00", "runner", "job-started", { runId: "1", runAttempt: "1", job: "lane-ios" }),
        marker("12:00:10", "sim-lease", "acquired", { lease: "a", lane: "ci", runId: "1" }),
        marker("12:01:00", "dispatcher", "worker-spawned", { issue: "MOV-1" }),
        marker("12:02:00", "sim-lease", "released", { lease: "a", runId: "1" }),
        marker("12:03:00", "runner", "job-completed", { runId: "1", runAttempt: "1" }),
      ],
      T("12:04:00"),
    );
    const overlaps = findOverlaps(spans, T("12:00:00"), T("12:04:00"), "1");
    expect(overlaps.map((o) => [o.a, o.b, o.durationMs])).toEqual([
      ["CI job lane-ios (run 1)", "dispatcher worker MOV-1", 120_000],
      ["simulator lease ci", "dispatcher worker MOV-1", 60_000],
    ]);
  });
});

describe("baseline", () => {
  const start = T("12:00:00");
  const base = (make) => series(start - 600_000, start - 5000, 5000, make);
  const run = (samples, markers = [], spans = []) => computeBaseline({ samples, markers, spans, startMs: start, ownRunId: "1" });

  it("does not flag a single warn reading or steady warn without swap growth", () => {
    const one = base((t) => sample(t, { pressure: t === start - 300_000 ? 2 : 1 }));
    expect(run(one).startedUnderPressure).toBe(false);
    expect(run(base((t) => sample(t, { pressure: 2 }))).startedUnderPressure).toBe(false);
  });
  it("flags sustained warn with swap growth, and any critical reading", () => {
    const grow = base((t) => sample(t, { pressure: 2, swapUsedMb: 2000 + (t - (start - 600_000)) / 1000 }));
    expect(run(grow)).toMatchObject({ startedUnderPressure: true, reason: expect.stringMatching(/sustained/) });
    const short = series(start - 40_000, start - 5000, 5000, (t) => sample(t, { pressure: 2, swapUsedMb: 2000 + (t - start) / 100 }));
    expect(run(short).startedUnderPressure).toBe(false);
    const crit = base((t) => sample(t, { pressure: t === start - 100_000 ? 4 : 1 }));
    expect(run(crit)).toMatchObject({ startedUnderPressure: true, reason: expect.stringMatching(/critical/) });
  });
  it("ignores samples outside the 10 minutes before start", () => {
    const old = [sample(start - 900_000, { pressure: 4 }), sample(start + 5000, { pressure: 4 })];
    expect(run(old)).toMatchObject({ sampleCount: 0, startedUnderPressure: false });
  });
  it("names leftover simulator processes and devices, and calls them the likely cause only under high load", () => {
    const procs = [{ pid: 200, cpu: 30, rssMb: 5, command: "/x/CoreSimulator/sbin/launchd_sim" }];
    const loud = base((t) => sample(t, { load: [90, 50, 20], runnable: 70, topCpu: procs, groups: { ...sample(t).groups, simulator: { count: 3, cpu: 30, rssMb: 5 } } }));
    const markers = [marker("11:30:00", "sim-lease", "device-booted", { device: "iPhone 17" })];
    const b = run(loud, markers);
    expect(b).toMatchObject({ leftoverSimulator: true, likelyCause: true, leftoverDevices: ["iPhone 17"] });
    expect(b.processes.map((p) => p.pid)).toEqual([200]);
    expect(likelyCauseLine(b)).toMatch(/iPhone 17.*launchd_sim \(pid 200\).*peak load 90.*peak runnable 70.*8 cores/);
    const calm = base((t) => sample(t, { topCpu: procs, groups: { ...sample(t).groups, simulator: { count: 3, cpu: 1, rssMb: 5 } } }));
    expect(run(calm)).toMatchObject({ leftoverSimulator: true, likelyCause: false });
  });
  it("reports runnable as unavailable when ps timed out and still uses load", () => {
    const b = run(base((t) => sample(t, { load: [90, 0, 0], runnable: null, simProcs: null, groups: { ...sample(t).groups, simulator: { count: 2, cpu: 1, rssMb: 5 } } })));
    expect(b).toMatchObject({ likelyCause: true, runnableUnavailable: true });
    expect(likelyCauseLine(b)).toMatch(/runnable unavailable/);
  });
  it("lists what was already running at start but not the run's own CI job", () => {
    const spans = buildSpans(
      [
        marker("11:55:00", "runner", "job-started", { runId: "9", runAttempt: "1", job: "other" }),
        marker("11:56:00", "sim-lease", "acquired", { lease: "z", lane: "worker" }),
        marker("11:57:00", "dispatcher", "worker-spawned", { issue: "MOV-3" }),
        marker("12:00:00", "runner", "job-started", { runId: "1", runAttempt: "1", job: "lane-ios" }),
      ],
      T("12:10:00"),
    );
    const b = run(base((t) => sample(t)), [], spans);
    expect(b.openAtStart.map((o) => o.kind).sort()).toEqual(["ci", "sim", "worker"]);
    expect(b.leftoverSimulator).toBe(false);
  });
});

describe("wedge lines", () => {
  it("builds one line per shutdown-incomplete and service-unresponsive marker, and none otherwise", () => {
    const incidents = wedgeIncidents([
      marker("12:00:00", "sim-lease", "shutdown-incomplete", { device: "moviecal-ci", phase: "release", elapsedMs: 61000, attempts: 2 }),
      marker("12:01:00", "sim-lease", "service-unresponsive", { devices: ["a", "b"] }),
      marker("12:02:00", "sim-lease", "released", {}),
    ]);
    expect(incidents.map(wedgeLine)).toEqual([
      "shutdown-incomplete at 12:00:00Z: device moviecal-ci, phase release, elapsed 1m01s, 2 attempts",
      "service-unresponsive at 12:01:00Z: CoreSimulatorService did not answer; devices a, b",
    ]);
    expect(wedgeIncidents([])).toEqual([]);
  });
  it("finds loadNoJob intervals with peaks, falling back to the CPU split when ps fields are null", () => {
    const hot = (t, over) => sample(t, { load: [100, 0, 0], loadNoJob: true, runnable: 90, simProcs: 40, ...over });
    const intervals = loadNoJobIntervals([
      sample(T("12:00:00")),
      hot(T("12:00:05")),
      hot(T("12:00:10"), { load: [150, 0, 0], runnable: 120, simProcs: 80 }),
      sample(T("12:00:15")),
      hot(T("12:00:20"), { runnable: null, simProcs: null, cpu: { user: 5, sys: 85, idle: 10 }, load: [200, 0, 0] }),
      hot(T("12:00:25"), { runnable: null, simProcs: null, loadNoJob: null, load: [180, 0, 0] }),
    ]);
    expect(intervals).toHaveLength(2);
    expect(noJobLine(intervals[0])).toBe("high load with no job running 12:00:05Z to 12:00:10Z (5s): peak load 150 (19x 8 cores), peak runnable 120, peak simProcs 80");
    expect(noJobLine(intervals[1])).toBe(
      "high load with no job running 12:00:20Z to 12:00:25Z (5s): peak load 200 (25x 8 cores), runnable and simProcs unavailable (ps timed out), CPU at peak user 5% sys 85% idle 10%",
    );
    expect(loadNoJobIntervals([sample(T("12:00:00")), sample(T("12:00:05"), { loadNoJob: null })])).toEqual([]);
  });
});

describe("result lookup and summary rendering", () => {
  it("prefers the job-result marker, then the job-completed result, then the status", () => {
    const ms = [
      marker("12:05:30", "runner", "job-completed", { runId: "1", result: "Failed" }),
      marker("12:05:50", "runner", "job-result", { runId: "1", result: "Canceled" }),
    ];
    expect(findResult({ markers: ms, runId: "1", startMs: 0 }).result).toBe("Canceled");
    expect(findResult({ markers: ms.slice(0, 1), runId: "1", startMs: 0 }).result).toBe("Failed");
    expect(findResult({ markers: [], runId: "1", status: "success", startMs: 0 })).toMatchObject({ result: "success" });
    expect(findResult({ markers: [], runId: "1", startMs: 0 }).result).toBeNull();
  });
  it("reads _diag when no marker has the result", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "Runner_20260110-120000-utc.log"), "[2026-01-10 12:05:48Z INFO Runner] Job lane-ios completed with result: Succeeded\n");
    expect(findResult({ markers: [], runId: "1", diagDir: root, startMs: T("12:00:00") })).toMatchObject({ result: "Succeeded" });
  });
  it("reads gzipped sample files", () => {
    const root = tmpRoot();
    writeJsonl(root, "samples-2026-01-10.jsonl", "samples", [sample(T("12:00:00")), sample(T("12:00:05"))], { gzip: true });
    expect(readSamples({ dir: root, sinceMs: T("12:00:01"), untilMs: T("12:01:00") })).toHaveLength(1);
  });
  it("renders a summary that always ends with the admin reminder, even with no data", () => {
    const report = {
      window: { startMs: T("12:00:00"), endMs: T("12:05:00"), open: false }, result: { result: null },
      stats: windowStats([]), groups: groupTotals([]), baseline: null, snapshots: [], crashReports: [], gaps: [], wedge: [], noJobIntervals: [],
    };
    const text = renderSummary(report);
    expect(text).toContain("unavailable");
    expect(text.trim().endsWith(`_${ADMIN_REMINDER}_`)).toBe(true);
    expect(text).not.toMatch(/shutdown-incomplete|high load with no job/);
  });
});
