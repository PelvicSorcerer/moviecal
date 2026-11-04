// Fixture telemetry day for the MOV-496 report tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { headerLine } from "../src/common.mjs";

export const T = (hms) => Date.parse(`2026-01-10T${hms}Z`);
export const iso = (ms) => new Date(ms).toISOString();

export function sample(atMs, over = {}) {
  return {
    t: iso(atMs), pressure: 1, freeMb: 900, compressorMb: 500, swapUsedMb: 2000, load: [1.5, 1.2, 1], cores: 8,
    thermal: { speedLimit: 100, warning: "none" }, diskFreeGb: 40, cpu: { user: 20, sys: 10, idle: 70 },
    runnable: 2, simProcs: 0, xpcproxySim: 0, loadNoJob: false, topCpu: [], topRss: [],
    groups: {
      runner: { count: 0, cpu: 0, rssMb: 0 }, xcode: { count: 0, cpu: 0, rssMb: 0 }, simulator: { count: 0, cpu: 0, rssMb: 0 },
      workers: { count: 0, cpu: 0, rssMb: 0 }, node: { count: 0, cpu: 0, rssMb: 0 }, other: { count: 5, cpu: 4, rssMb: 300 },
    },
    busy: false, notes: [], ...over,
  };
}

export function series(fromMs, toMs, stepMs, make) {
  const out = [];
  for (let t = fromMs; t <= toMs; t += stepMs) out.push(make(t));
  return out;
}

export function marker(hms, source, event, fields = {}) {
  return { t: iso(T(hms)), source, event, ...fields };
}

export function writeJsonl(dir, name, kind, rows, { gzip = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const text = [headerLine(kind), ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n";
  if (gzip) fs.writeFileSync(path.join(dir, `${name}.gz`), zlib.gzipSync(text));
  else fs.writeFileSync(path.join(dir, name), text);
}

const SIM_PROCS = [
  { pid: 200, cpu: 30, rssMb: 50, command: "/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/sbin/launchd_sim" },
  { pid: 300, cpu: 5, rssMb: 80, command: "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild" },
];

// One UTC day: idle with a leftover simulator and a pre-job load incident, a full lane-ios job (run 555), a
// dispatcher worker overlapping it, a stall-ish snapshot, a sampling gap and a crash report. Samples are gzipped.
export function buildFixtureDay({ root, gzipSamples = true } = {}) {
  const dir = path.join(root, "telemetry");
  const reports = path.join(root, "DiagnosticReports");
  const samples = [
    ...series(T("11:50:00"), T("11:59:58"), 5000, (t) =>
      sample(t, {
        pressure: 2, load: [40, 30, 20],
        ...(t >= T("11:58:30") ? { runnable: null, simProcs: null } : { runnable: 30, simProcs: 60 }),
        loadNoJob: (t >= T("11:55:00") && t < T("11:56:00")) || (t >= T("11:58:30") && t < T("11:59:30")),
        topCpu: SIM_PROCS, topRss: SIM_PROCS,
        groups: { ...sample(t).groups, simulator: { count: 3, cpu: 30, rssMb: 50 }, xcode: { count: 1, cpu: 5, rssMb: 80 } },
      }),
    ),
    ...series(T("12:00:00"), T("12:03:00") - 1500, 1500, (t) =>
      sample(t, {
        busy: true, swapUsedMb: 2100, load: [6, 4, 3], pressure: 2,
        groups: { ...sample(t).groups, xcode: { count: 2, cpu: 100, rssMb: 900 }, simulator: { count: 8, cpu: 50, rssMb: 700 }, runner: { count: 1, cpu: 10, rssMb: 100 } },
      }),
    ),
    ...series(T("12:03:30"), T("12:05:30"), 1500, (t) =>
      sample(t, { busy: true, swapUsedMb: 2300, load: [7, 5, 3], pressure: 2, groups: { ...sample(t).groups, xcode: { count: 2, cpu: 80, rssMb: 950 } } }),
    ),
  ];
  const markers = [
    marker("11:30:00", "sim-lease", "device-booted", { lane: "worker", lease: "w1", device: "iPhone 17", udid: "U1" }),
    marker("11:58:00", "dispatcher", "worker-spawned", { issue: "MOV-9", adapter: "claude", attempt: "initial" }),
    marker("12:00:00", "runner", "job-started", { runId: "555", runAttempt: "1", job: "lane-ios" }),
    marker("12:00:05", "sim-lease", "shutdown-incomplete", { lane: "ci", runId: "555", device: "moviecal-ci", phase: "cleanup", elapsedMs: 45000, attempts: 3 }),
    marker("12:00:10", "sim-lease", "acquired", { lane: "ci", lease: "L1", runId: "555", device: "moviecal-ci", waitMs: 5000 }),
    marker("12:00:40", "sim-lease", "device-booted", { lane: "ci", lease: "L1", runId: "555", device: "moviecal-ci", bootMs: 30000 }),
    marker("12:00:41", "sim-lease", "command-started", { lane: "ci", lease: "L1", runId: "555", command: "xcodebuild" }),
    marker("12:01:30", "sim-lease", "first-test-started", { lane: "ci", lease: "L1", runId: "555", afterCommandMs: 49000 }),
    marker("12:02:00", "dispatcher", "worker-exited", { issue: "MOV-9", exitCode: 0, classification: "ok", durationMs: 240000 }),
    marker("12:02:01", "sampler", "snapshot", { file: "snapshot-2026-01-10T12-02-00.000Z.txt", reasons: ["load 24 above 2x 8 cores"] }),
    marker("12:05:00", "sim-lease", "command-exited", { lane: "ci", lease: "L1", runId: "555", command: "xcodebuild", exitCode: 0, durationMs: 259000 }),
    marker("12:05:20", "sim-lease", "released", { lane: "ci", lease: "L1", runId: "555", device: "moviecal-ci", releaseMs: 20000 }),
    marker("12:05:30", "runner", "job-completed", { runId: "555", runAttempt: "1", job: "lane-ios", result: null }),
    marker("12:05:50", "runner", "job-result", { runId: "555", runAttempt: "1", job: "lane-ios", result: "Succeeded", resultSource: "runner-log" }),
  ];
  writeJsonl(dir, "samples-2026-01-10.jsonl", "samples", samples, { gzip: gzipSamples });
  writeJsonl(dir, "markers-2026-01-10.jsonl", "markers", markers, { gzip: gzipSamples });
  fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(dir, "snapshots", "snapshot-2026-01-10T12-02-00.000Z.txt"), "snapshot");
  fs.mkdirSync(reports, { recursive: true });
  const jetsam = path.join(reports, "JetsamEvent-2026-01-10-120300.ips");
  fs.writeFileSync(jetsam, "{}");
  fs.utimesSync(jetsam, T("12:03:00") / 1000, T("12:03:00") / 1000);
  const old = path.join(reports, "Old-crash.ips");
  fs.writeFileSync(old, "{}");
  fs.utimesSync(old, T("08:00:00") / 1000, T("08:00:00") / 1000);
  return { dir, reports, nowMs: T("12:06:00") };
}

export function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-report-"));
}
