// Report data loading and analysis for bin/report.mjs. MOV-496.
// Pure analysis over sample/marker/snapshot files written by the sampler (MOV-494) and markers (MOV-495).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DAY_MS, utcDate } from "./common.mjs";
import { BUSY_INTERVAL_MS, IDLE_INTERVAL_MS } from "./loop.mjs";
import { readMarkers } from "./markers.mjs";
import { diagDirectory } from "./runner-hook.mjs";
import { lookupResult } from "./job-result.mjs";
import { GROUPS } from "./parse.mjs";
import { LOAD_FACTOR, WARN_SUSTAIN_MS } from "./triggers.mjs";

export const BASELINE_MS = 10 * 60_000;
export const GAP_FACTOR = 3;
export const RUN_LOOKBACK_MS = 14 * DAY_MS;
const SPAN_LOOKBACK_MS = 6 * 60 * 60_000;
const RESULT_TAIL_MS = 10 * 60_000;
const MAX_JOB_MS = 8 * 60 * 60_000;
const SIM_PROCESS = /xcodebuild|xctest|CoreSimulator|launchd_sim|Simulator\.app|simctl/;
const REPORT_FILE = /\.(ips|crash|diag|spin|hang)$/i;

export const DEFAULT_REPORT_DIRS = ["/Library/Logs/DiagnosticReports", path.join(os.homedir(), "Library", "Logs", "DiagnosticReports")];

const ms = (iso) => Date.parse(iso);
const nums = (values) => values.filter((v) => typeof v === "number" && Number.isFinite(v));
const max = (values) => (values.length ? Math.max(...values) : null);
const min = (values) => (values.length ? Math.min(...values) : null);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (n, d = 1) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(text).trim());
  if (!m) throw new Error(`bad duration "${text}" (use 30m, 2h, 1d)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[m[2]];
}

function readJsonLines(file) {
  try {
    const raw = fs.readFileSync(file);
    const text = file.endsWith(".gz") ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    return text.split("\n").flatMap((line) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function readSamples({ dir, sinceMs, untilMs }) {
  const out = [];
  for (let day = Math.floor(sinceMs / DAY_MS) * DAY_MS; day <= untilMs; day += DAY_MS) {
    for (const file of [`samples-${utcDate(day)}.jsonl`, `samples-${utcDate(day)}.jsonl.gz`]) {
      out.push(...readJsonLines(path.join(dir, file)).filter((s) => s && !s.header && typeof s.t === "string"));
    }
  }
  return out
    .filter((s) => ms(s.t) >= sinceMs && ms(s.t) <= untilMs)
    .sort((a, b) => ms(a.t) - ms(b.t));
}

export function readSnapshots({ dir, startMs, endMs, markers }) {
  const snapDir = path.join(dir, "snapshots");
  let names = [];
  try {
    names = fs.readdirSync(snapDir);
  } catch {
    return [];
  }
  const reasonsByFile = new Map(
    markers.filter((m) => m.source === "sampler" && m.event === "snapshot").map((m) => [String(m.file), m.reasons]),
  );
  const out = [];
  for (const name of names) {
    const m = /^snapshot-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)/.exec(name);
    if (!m) continue;
    const atMs = ms(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
    if (atMs >= startMs && atMs <= endMs) {
      out.push({ name, file: path.join(snapDir, name), atMs, reasons: reasonsByFile.get(name.replace(/\.gz$/, "")) ?? null });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export function readCrashReports({ dirs, startMs, endMs }) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!REPORT_FILE.test(name)) continue;
      try {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.mtimeMs >= startMs && stat.mtimeMs <= endMs) {
          out.push({ name, file, atMs: stat.mtimeMs, jetsam: /jetsam/i.test(name) });
        }
      } catch {
        // vanished or unreadable
      }
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export function gapThresholdMs(sample) {
  return GAP_FACTOR * (sample?.busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
}

// Intervals between consecutive samples (and the window edges) longer than 3x the expected cadence.
export function findGaps(samples, startMs, endMs) {
  if (endMs <= startMs) return [];
  if (samples.length === 0) return [{ fromMs: startMs, toMs: endMs, durationMs: endMs - startMs, noSamples: true }];
  const edge = GAP_FACTOR * IDLE_INTERVAL_MS;
  const gaps = [];
  const add = (fromMs, toMs) => gaps.push({ fromMs, toMs, durationMs: toMs - fromMs });
  if (ms(samples[0].t) - startMs > edge) add(startMs, ms(samples[0].t));
  for (let i = 1; i < samples.length; i += 1) {
    const from = ms(samples[i - 1].t);
    const to = ms(samples[i].t);
    if (to - from > gapThresholdMs(samples[i - 1])) add(from, to);
  }
  const last = ms(samples.at(-1).t);
  if (endMs - last > edge) add(last, endMs);
  return gaps;
}

export function windowStats(samples) {
  const pressure = nums(samples.map((s) => s.pressure));
  const swap = nums(samples.map((s) => s.swapUsedMb));
  const load = nums(samples.map((s) => s.load?.[0]));
  return {
    sampleCount: samples.length,
    pressure: { peak: max(pressure), avg: round(mean(pressure), 2) },
    swap: { first: swap[0] ?? null, last: swap.at(-1) ?? null, change: swap.length ? round(swap.at(-1) - swap[0]) : null, peak: max(swap) },
    load: { peak: max(load), avg: round(mean(load), 2), cores: samples.find((s) => s.cores)?.cores ?? null },
    thermalMinSpeedLimit: min(nums(samples.map((s) => s.thermal?.speedLimit))),
    diskFreeMinGb: min(nums(samples.map((s) => s.diskFreeGb))),
  };
}

// CPU-seconds integrate each sample's %CPU over the interval to the next one (capped at the gap threshold).
export function groupTotals(samples) {
  const totals = Object.fromEntries(GROUPS.map((g) => [g, { cpuSeconds: 0, peakRssMb: 0, peakCount: 0 }]));
  let psMissing = 0;
  samples.forEach((s, i) => {
    if (!s.groups) {
      psMissing += 1;
      return;
    }
    const dtMs = i + 1 < samples.length ? Math.min(ms(samples[i + 1].t) - ms(s.t), gapThresholdMs(s)) : 0;
    for (const g of GROUPS) {
      const v = s.groups[g];
      if (!v) continue;
      totals[g].cpuSeconds += ((v.cpu ?? 0) / 100) * (dtMs / 1000);
      totals[g].peakRssMb = Math.max(totals[g].peakRssMb, v.rssMb ?? 0);
      totals[g].peakCount = Math.max(totals[g].peakCount, v.count ?? 0);
    }
  });
  for (const t of Object.values(totals)) t.cpuSeconds = round(t.cpuSeconds);
  return { totals, psMissing };
}

// Spans from markers: CI jobs (runner), simulator leases (sim-lease) and dispatcher workers.
export function buildSpans(markers, endMs) {
  const spans = [];
  const open = new Map();
  const begin = (key, span, m) => {
    if (!open.has(key)) open.set(key, { ...span, startMs: ms(m.t), endMs: null, open: true });
  };
  const finish = (key, m) => {
    const s = open.get(key);
    if (!s) return;
    open.delete(key);
    spans.push({ ...s, endMs: ms(m.t), open: false });
  };
  for (const m of markers) {
    if (m.source === "runner" && m.event === "job-started") {
      begin(`ci:${m.runId}:${m.runAttempt}`, { kind: "ci", runId: m.runId == null ? null : String(m.runId), label: `CI job ${m.job ?? "?"} (run ${m.runId ?? "?"})` }, m);
    } else if (m.source === "runner" && m.event === "job-completed") {
      finish(`ci:${m.runId}:${m.runAttempt}`, m);
    } else if (m.source === "sim-lease" && m.event === "acquired") {
      const id = m.lease ?? `${m.lane}:${m.runId}`;
      begin(`sim:${id}`, { kind: "sim", runId: m.runId == null ? null : String(m.runId), label: `simulator lease ${m.lane ?? "?"}${m.device ? ` on ${m.device}` : ""}` }, m);
    } else if (m.source === "sim-lease" && m.event === "released") {
      finish(`sim:${m.lease ?? `${m.lane}:${m.runId}`}`, m);
    } else if (m.source === "dispatcher" && m.event === "worker-spawned") {
      begin(`worker:${m.issue}`, { kind: "worker", runId: null, label: `dispatcher worker ${m.issue ?? "?"}${m.adapter ? ` (${m.adapter})` : ""}` }, m);
    } else if (m.source === "dispatcher" && m.event === "worker-exited") {
      finish(`worker:${m.issue}`, m);
    }
  }
  for (const s of open.values()) spans.push({ ...s, endMs: Math.max(endMs, s.startMs) });
  return spans.sort((a, b) => a.startMs - b.startMs);
}

export function findOverlaps(spans, startMs, endMs, runId = null) {
  const out = [];
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const a = spans[i];
      const b = spans[j];
      if (a.kind === b.kind && a.kind !== "ci") continue;
      if (runId !== null && a.runId === runId && b.runId === runId) continue;
      const from = Math.max(a.startMs, b.startMs, startMs);
      const to = Math.min(a.endMs, b.endMs, endMs);
      if (to > from) out.push({ a: a.label, b: b.label, kinds: [a.kind, b.kind], fromMs: from, toMs: to, durationMs: to - from });
    }
  }
  return out.sort((x, y) => y.durationMs - x.durationMs);
}

const TIMELINE_EVENTS = new Set([
  "runner:job-started", "runner:job-completed", "runner:job-result",
  "sim-lease:acquired", "sim-lease:adopted", "sim-lease:device-boot-started", "sim-lease:device-booted",
  "sim-lease:command-started", "sim-lease:first-test-started", "sim-lease:command-exited", "sim-lease:released",
  "sim-lease:shutdown-incomplete", "sim-lease:service-unresponsive",
  "dispatcher:worker-spawned", "dispatcher:worker-exited", "sampler:snapshot",
]);

export function timelineOf(markers) {
  return markers
    .filter((m) => TIMELINE_EVENTS.has(`${m.source}:${m.event}`))
    .map((m) => ({ atMs: ms(m.t), source: m.source, event: m.event, marker: m }));
}

export function wedgeIncidents(markers) {
  return markers
    .filter((m) => m.source === "sim-lease" && (m.event === "shutdown-incomplete" || m.event === "service-unresponsive"))
    .map((m) => ({
      atMs: ms(m.t),
      event: m.event,
      device: m.device ?? (Array.isArray(m.devices) ? m.devices.join(", ") : m.devices ?? null),
      phase: m.phase ?? null,
      elapsedMs: typeof m.elapsedMs === "number" ? m.elapsedMs : null,
      attempts: m.attempts ?? null,
    }));
}

// Contiguous intervals of loadNoJob. A sample with loadNoJob null (ps failed) and high load keeps an interval open.
export function loadNoJobIntervals(samples) {
  const out = [];
  let cur = null;
  const close = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  for (const s of samples) {
    const high = s.load?.[0] > LOAD_FACTOR * (s.cores ?? Infinity);
    const inside = s.loadNoJob === true || (s.loadNoJob === null && high && cur !== null);
    if (!inside) {
      close();
      continue;
    }
    if (!cur) cur = { fromMs: ms(s.t), toMs: ms(s.t), samples: 0, peakLoad: null, peakRunnable: null, peakSimProcs: null, psMissing: 0, cpuAtPeak: null };
    cur.toMs = ms(s.t);
    cur.samples += 1;
    if (s.load?.[0] > (cur.peakLoad ?? -1)) {
      cur.peakLoad = s.load[0];
      cur.cpuAtPeak = s.cpu ?? null;
    }
    if (typeof s.runnable === "number") cur.peakRunnable = Math.max(cur.peakRunnable ?? 0, s.runnable);
    if (typeof s.simProcs === "number") cur.peakSimProcs = Math.max(cur.peakSimProcs ?? 0, s.simProcs);
    if (s.runnable == null && s.simProcs == null) cur.psMissing += 1;
  }
  close();
  return out.map((i) => ({ ...i, durationMs: i.toMs - i.fromMs, cores: samples.find((s) => s.cores)?.cores ?? null }));
}

function sustainedWarnWithSwapGrowth(samples) {
  let run = [];
  const qualifies = () => {
    if (run.length < 2 || ms(run.at(-1).t) - ms(run[0].t) < WARN_SUSTAIN_MS) return false;
    const swap = nums(run.map((s) => s.swapUsedMb));
    return swap.length >= 2 && swap.at(-1) > swap[0];
  };
  for (const s of samples) {
    if (typeof s.pressure === "number" && s.pressure >= 2) run.push(s);
    else if (typeof s.pressure === "number") {
      if (qualifies()) return true;
      run = [];
    }
  }
  return qualifies();
}

// What the Mac looked like in the 10 minutes before the job-start marker. A single warn reading never flags
// "started under pressure" (the Mac idles at warn): it takes sustained warn plus swap growth, or any critical reading.
export function computeBaseline({ samples, markers, spans, startMs, ownRunId = null }) {
  const before = samples.filter((s) => ms(s.t) >= startMs - BASELINE_MS && ms(s.t) < startMs);
  const stats = windowStats(before);
  const critical = before.some((s) => s.pressure >= 4);
  const sustained = sustainedWarnWithSwapGrowth(before);
  const startedUnderPressure = critical || sustained;
  const reason = critical ? "critical memory pressure reading" : sustained ? "sustained memory pressure warn with swap growth" : null;

  const openAtStart = spans.filter((s) => s.startMs < startMs && s.endMs > startMs && !(s.kind === "ci" && s.runId === ownRunId));
  const lastWithPs = [...before].reverse().find((s) => s.groups);
  const processes = [];
  const seen = new Set();
  for (const p of [...(lastWithPs?.topCpu ?? []), ...(lastWithPs?.topRss ?? [])]) {
    if (!SIM_PROCESS.test(p.command) || seen.has(`${p.pid}`)) continue;
    seen.add(`${p.pid}`);
    processes.push({ pid: p.pid, command: p.command, cpu: p.cpu, rssMb: p.rssMb });
  }

  // Devices booted before the start with no release since: from markers.
  const booted = new Map();
  for (const m of markers) {
    if (ms(m.t) >= startMs || m.source !== "sim-lease" || !m.device) continue;
    if (m.event === "device-booted" || m.event === "adopted" || m.event === "shutdown-incomplete") booted.set(m.device, m.event);
    else if (m.event === "released" && !m.keepBooted) booted.delete(m.device);
  }
  const heldLease = openAtStart.some((s) => s.kind === "sim");
  const simCount = lastWithPs?.groups?.simulator?.count ?? 0;
  const leftoverDevices = heldLease ? [] : [...booted.keys()];
  const leftoverSimulator = !heldLease && (leftoverDevices.length > 0 || simCount > 0 || (lastWithPs?.simProcs ?? 0) > 0);

  const cores = stats.load.cores;
  const runnablePeak = max(nums(before.map((s) => s.runnable)));
  const loadPeak = stats.load.peak;
  const farAbove = cores !== null && ((loadPeak ?? 0) > LOAD_FACTOR * cores || (runnablePeak ?? 0) > LOAD_FACTOR * cores);
  return {
    sampleCount: before.length,
    stats,
    startedUnderPressure,
    reason,
    runnablePeak,
    runnableUnavailable: before.length > 0 && before.every((s) => s.runnable == null),
    openAtStart: openAtStart.map((s) => ({ kind: s.kind, label: s.label })),
    processes,
    leftoverSimulator,
    leftoverDevices,
    simulatorProcessCount: simCount,
    xcodeProcessCount: lastWithPs?.groups?.xcode?.count ?? 0,
    likelyCause: leftoverSimulator && farAbove,
  };
}

export function findResult({ markers, runId, status, diagDir, startMs }) {
  const mine = markers.filter((m) => runId !== null && String(m.runId) === runId);
  const jobResult = mine.find((m) => m.source === "runner" && m.event === "job-result" && m.result);
  if (jobResult) return { result: jobResult.result, source: "job-result marker" };
  const completed = mine.find((m) => m.source === "runner" && m.event === "job-completed" && m.result);
  if (completed) return { result: completed.result, source: "job-completed marker" };
  if (status) return { result: status, source: "job status at summary time (job still running)" };
  if (diagDir) {
    const found = lookupResult(diagDir, startMs);
    if (found.result) return { result: found.result, source: `runner _diag (${found.source})` };
  }
  return { result: null, source: null };
}

export function resolveWindow({ markers, runId, sinceMs, fromMs, toMs, nowMs }) {
  if (runId) {
    const mine = markers.filter((m) => m.runId != null && String(m.runId) === runId);
    if (mine.length === 0) return { error: `no telemetry markers for run ${runId}` };
    const starts = mine.filter((m) => m.source === "runner" && m.event === "job-started");
    const first = starts.at(-1) ?? mine[0];
    const startMs = ms(first.t);
    const done = mine.find((m) => m.source === "runner" && m.event === "job-completed" && ms(m.t) >= startMs);
    const open = !done;
    return { startMs, endMs: done ? ms(done.t) : Math.min(nowMs, startMs + MAX_JOB_MS), open, runId };
  }
  if (fromMs != null || toMs != null) return { startMs: fromMs ?? (toMs ?? nowMs) - DAY_MS, endMs: toMs ?? nowMs, open: false, runId: null };
  if (sinceMs != null) return { startMs: nowMs - sinceMs, endMs: nowMs, open: false, runId: null };
  return { error: "give --run <id>, --since <duration>, or --from/--to" };
}

export function buildReport({ dir, runId = null, sinceMs = null, fromMs = null, toMs = null, nowMs = Date.now(), reportDirs = DEFAULT_REPORT_DIRS, diagDir = diagDirectory(process.env), status = null }) {
  if (!fs.existsSync(dir)) return { error: `telemetry folder not found: ${dir}` };
  const run = runId === null ? null : String(runId);
  const lookupFrom = run ? nowMs - RUN_LOOKBACK_MS : 0;
  const window = resolveWindow({
    markers: run ? readMarkers({ dir, sinceMs: lookupFrom, untilMs: nowMs }) : [],
    runId: run, sinceMs, fromMs, toMs, nowMs,
  });
  if (window.error) return { error: window.error };
  const { startMs, endMs } = window;
  const wide = readMarkers({ dir, sinceMs: startMs - SPAN_LOOKBACK_MS, untilMs: Math.min(nowMs, endMs + RESULT_TAIL_MS) });
  const markers = wide.filter((m) => ms(m.t) >= startMs && ms(m.t) <= endMs);
  const samples = readSamples({ dir, sinceMs: startMs - BASELINE_MS, untilMs: endMs });
  const inWindow = samples.filter((s) => ms(s.t) >= startMs);
  const spans = buildSpans(wide.filter((m) => ms(m.t) <= endMs), endMs);

  const anchor = run
    ? startMs
    : (() => {
        const m = markers.find((x) => x.source === "runner" && x.event === "job-started");
        return m ? ms(m.t) : null;
      })();
  const ownRun = run ?? (anchor !== null ? String(markers.find((x) => x.source === "runner" && x.event === "job-started").runId ?? "") : null);
  const result = findResult({ markers: wide, runId: ownRun || null, status, diagDir, startMs });
  return {
    window, runId: run, nowMs,
    timeline: timelineOf(markers),
    stats: windowStats(inWindow),
    groups: groupTotals(inWindow),
    spans, overlaps: findOverlaps(spans, startMs, endMs, run),
    snapshots: readSnapshots({ dir, startMs, endMs, markers }),
    crashReports: readCrashReports({ dirs: reportDirs, startMs, endMs }),
    gaps: findGaps(inWindow, startMs, endMs),
    wedge: wedgeIncidents(markers),
    noJobIntervals: loadNoJobIntervals(inWindow),
    baseline: anchor === null ? null : computeBaseline({ samples, markers: wide, spans, startMs: anchor, ownRunId: ownRun }),
    result,
    resultMarkers: markers.filter((m) => m.source === "sim-lease" && m.event === "command-exited"),
  };
}
