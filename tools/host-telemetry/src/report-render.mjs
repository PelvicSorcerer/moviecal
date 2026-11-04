// Text rendering for bin/report.mjs: the full report and the short Markdown CI job summary. MOV-496.
import path from "node:path";
import { ADMIN_REMINDER } from "./common.mjs";
import { GROUPS } from "./parse.mjs";

const GROUP_LABELS = { runner: "runner", xcode: "xcodebuild", simulator: "simulator", workers: "dispatcher workers", node: "node/vitest", other: "other" };
const PRESSURE_NAMES = { 1: "normal", 2: "warn", 4: "critical" };

export function fmtDur(durationMs) {
  if (durationMs == null || !Number.isFinite(durationMs)) return "unknown";
  const s = Math.round(durationMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const fmtTime = (atMs) => `${new Date(atMs).toISOString().slice(11, 19)}Z`;
const fmtPressure = (p) => (p == null ? "unavailable" : `${p} (${PRESSURE_NAMES[Math.round(p)] ?? "?"})`);
const fmtNum = (n, unit = "") => (n == null ? "unavailable" : `${n}${unit}`);
const fmtSigned = (n, unit = "") => (n == null ? "unavailable" : `${n > 0 ? "+" : ""}${n}${unit}`);
const procName = (p) => `${path.basename(p.command)} (pid ${p.pid})`;

function eventDetail(m) {
  const bits = [];
  const add = (label, value, fmt = (v) => v) => {
    if (value !== undefined && value !== null) bits.push(`${label} ${fmt(value)}`);
  };
  switch (`${m.source}:${m.event}`) {
    case "runner:job-started":
      add("job", m.job);
      add("run", m.runId);
      break;
    case "runner:job-completed":
    case "runner:job-result":
      add("result", m.result);
      break;
    case "sim-lease:acquired":
      add("lane", m.lane);
      add("waited", m.waitMs, fmtDur);
      add("device", m.device);
      break;
    case "sim-lease:device-booted":
      add("device", m.device);
      add("boot took", m.bootMs, fmtDur);
      break;
    case "sim-lease:command-started":
      add("command", m.command);
      break;
    case "sim-lease:first-test-started":
      add("after command start", m.afterCommandMs, fmtDur);
      break;
    case "sim-lease:command-exited":
      add("exit", m.exitCode);
      add("took", m.durationMs, fmtDur);
      add("stalled", m.stalled);
      break;
    case "sim-lease:released":
      add("release took", m.releaseMs, fmtDur);
      break;
    case "sim-lease:shutdown-incomplete":
      add("device", m.device);
      add("phase", m.phase);
      add("elapsed", m.elapsedMs, fmtDur);
      break;
    case "dispatcher:worker-spawned":
      add("issue", m.issue);
      add("adapter", m.adapter);
      break;
    case "dispatcher:worker-exited":
      add("issue", m.issue);
      add("exit", m.exitCode);
      add("class", m.classification);
      add("took", m.durationMs, fmtDur);
      break;
    case "sampler:snapshot":
      add("file", m.file);
      add("reasons", Array.isArray(m.reasons) ? m.reasons.join("; ") : m.reasons);
      break;
    default:
  }
  return bits.join(", ");
}

export function wedgeLine(w) {
  if (w.event === "service-unresponsive") return `service-unresponsive at ${fmtTime(w.atMs)}: CoreSimulatorService did not answer; devices ${w.device ?? "unknown"}`;
  return `shutdown-incomplete at ${fmtTime(w.atMs)}: device ${w.device ?? "unknown"}, phase ${w.phase ?? "unknown"}, elapsed ${w.elapsedMs == null ? "unknown" : fmtDur(w.elapsedMs)}${w.attempts ? `, ${w.attempts} attempts` : ""}`;
}

export function noJobLine(i) {
  const head = `high load with no job running ${fmtTime(i.fromMs)} to ${fmtTime(i.toMs)} (${fmtDur(i.durationMs)})`;
  const ratio = i.cores && i.peakLoad != null ? ` (${Math.round(i.peakLoad / i.cores)}x ${i.cores} cores)` : "";
  const load = `peak load ${fmtNum(i.peakLoad)}${ratio}`;
  if (i.peakRunnable == null && i.peakSimProcs == null) {
    const c = i.cpuAtPeak;
    const cpu = c ? `, CPU at peak user ${c.user}% sys ${c.sys}% idle ${c.idle}%` : ", CPU split unavailable";
    return `${head}: ${load}, runnable and simProcs unavailable (ps timed out)${cpu}`;
  }
  return `${head}: ${load}, peak runnable ${fmtNum(i.peakRunnable)}, peak simProcs ${fmtNum(i.peakSimProcs)}`;
}

export function likelyCauseLine(b) {
  const names = [...b.leftoverDevices, ...b.processes.filter((p) => /launchd_sim|CoreSimulator|Simulator\.app/.test(p.command)).map(procName)];
  const what = names.length ? names.join(", ") : `${b.simulatorProcessCount} simulator processes`;
  const runnable = b.runnableUnavailable ? "runnable unavailable (ps timed out)" : `peak runnable ${fmtNum(b.runnablePeak)}`;
  return `Likely cause: leftover booted simulator (${what}) with peak load ${fmtNum(b.stats.load.peak)}, ${runnable}, against ${fmtNum(b.stats.load.cores)} cores`;
}

function baselineLines(b) {
  if (!b) return ["No job-start marker in the window, so no baseline."];
  if (b.sampleCount === 0) return ["No samples in the 10 minutes before job start, so the baseline is unavailable."];
  const s = b.stats;
  const out = [
    `Flag: ${b.startedUnderPressure ? `STARTED UNDER PRESSURE (${b.reason})` : "not started under pressure"}`,
    `Pressure peak ${fmtPressure(s.pressure.peak)}, avg ${fmtNum(s.pressure.avg)}; swap ${fmtNum(s.swap.last, " MB")} (change ${fmtSigned(s.swap.change, " MB")})`,
    `Load peak ${fmtNum(s.load.peak)}, avg ${fmtNum(s.load.avg)} on ${fmtNum(s.load.cores)} cores; thermal speed limit min ${fmtNum(s.thermalMinSpeedLimit)}; free disk min ${fmtNum(s.diskFreeMinGb, " GB")}`,
  ];
  const running = b.openAtStart.map((o) => o.label);
  out.push(`Already running at start: ${running.length ? running.join("; ") : "no other CI job, simulator lease or dispatcher worker"}`);
  const leftovers = b.processes.map(procName);
  out.push(`Leftover simulator/xcodebuild processes: ${leftovers.length ? leftovers.join(", ") : b.simulatorProcessCount + b.xcodeProcessCount > 0 ? `${b.simulatorProcessCount} simulator and ${b.xcodeProcessCount} xcodebuild-group processes (not in the top lists)` : "none"}`);
  if (b.leftoverDevices.length) out.push(`Simulator devices booted with no release: ${b.leftoverDevices.join(", ")}`);
  if (b.likelyCause) out.push(likelyCauseLine(b));
  return out;
}

function windowLabel(r) {
  const w = r.window;
  return `${new Date(w.startMs).toISOString()} to ${new Date(w.endMs).toISOString()} (${fmtDur(w.endMs - w.startMs)})${w.open ? ", job still running" : ""}`;
}

function resultLine(r) {
  if (r.result.result) return `${r.result.result} (${r.result.source})`;
  const exits = r.resultMarkers.map((m) => `${m.command ?? "command"} exit ${m.exitCode}`);
  return `unknown, no result marker or runner _diag line${exits.length ? `; lease commands: ${exits.join(", ")}` : ""}`;
}

function topGroups(r, key) {
  return GROUPS.map((g) => ({ g, ...r.groups.totals[g] }))
    .sort((a, b) => b[key] - a[key])
    .filter((x) => x[key] > 0)
    .slice(0, 3);
}

export function renderFull(r) {
  const out = ["# MovieCal host telemetry report", "", `Window: ${windowLabel(r)}`];
  if (r.runId) out.push(`Run: ${r.runId}`);
  out.push(`Result: ${resultLine(r)}`, "");

  out.push("## Pre-job baseline (10 minutes before job start)", ...baselineLines(r.baseline).map((l) => `- ${l}`), "");

  out.push("## Timeline");
  if (r.timeline.length === 0) out.push("- no markers in the window");
  for (const e of r.timeline) {
    const detail = eventDetail(e.marker);
    out.push(`- +${fmtDur(e.atMs - r.window.startMs).padEnd(7)} ${fmtTime(e.atMs)}  ${e.source} ${e.event}${detail ? `: ${detail}` : ""}`);
  }
  out.push("");

  const s = r.stats;
  out.push("## Window statistics", `- Samples: ${s.sampleCount}`);
  out.push(`- Memory pressure: peak ${fmtPressure(s.pressure.peak)}, avg ${fmtNum(s.pressure.avg)}`);
  out.push(`- Swap: ${fmtNum(s.swap.first, " MB")} to ${fmtNum(s.swap.last, " MB")} (change ${fmtSigned(s.swap.change, " MB")}, peak ${fmtNum(s.swap.peak, " MB")})`);
  out.push(`- Load (1 min): peak ${fmtNum(s.load.peak)}, avg ${fmtNum(s.load.avg)} on ${fmtNum(s.load.cores)} cores`);
  out.push(`- Thermal speed limit min: ${fmtNum(s.thermalMinSpeedLimit)}; free disk min: ${fmtNum(s.diskFreeMinGb, " GB")}`, "");

  out.push("## CPU-seconds and peak RSS by group");
  for (const g of GROUPS) {
    const t = r.groups.totals[g];
    out.push(`- ${GROUP_LABELS[g].padEnd(18)} ${String(t.cpuSeconds).padStart(8)} CPU-s   peak RSS ${t.peakRssMb} MB   peak ${t.peakCount} processes`);
  }
  if (r.groups.psMissing) out.push(`- ${r.groups.psMissing} samples had no process data (ps unavailable); they are excluded from the totals`);
  out.push("");

  out.push("## Overlaps (CI jobs, simulator use, dispatcher workers)");
  if (r.overlaps.length === 0) out.push("- none");
  for (const o of r.overlaps.slice(0, 10)) out.push(`- ${o.a} overlapped ${o.b} for ${fmtDur(o.durationMs)} (${fmtTime(o.fromMs)} to ${fmtTime(o.toMs)})`);
  out.push("");

  out.push("## Deep snapshots and crash/Jetsam reports");
  if (r.snapshots.length + r.crashReports.length === 0) out.push("- none created in the window");
  for (const sn of r.snapshots) out.push(`- snapshot ${sn.name} at ${fmtTime(sn.atMs)}${sn.reasons ? ` (${sn.reasons.join("; ")})` : ""}`);
  for (const c of r.crashReports) out.push(`- ${c.jetsam ? "Jetsam report" : "crash report"} ${c.file} at ${fmtTime(c.atMs)}`);
  out.push("");

  out.push("## Sampling gaps (longer than 3x the expected cadence)");
  if (r.gaps.length === 0) out.push("- none");
  for (const g of r.gaps) out.push(`- GAP ${fmtTime(g.fromMs)} to ${fmtTime(g.toMs)} (${fmtDur(g.durationMs)})${g.noSamples ? ": no samples at all" : ""}`);
  out.push("");

  if (r.wedge.length || r.noJobIntervals.length) {
    out.push("## Simulator wedge indicators");
    for (const w of r.wedge) out.push(`- ${wedgeLine(w)}`);
    for (const i of r.noJobIntervals) out.push(`- ${noJobLine(i)}`);
    out.push("");
  }

  out.push(ADMIN_REMINDER);
  return out.join("\n");
}

export function renderSummary(r) {
  const w = r.window;
  const s = r.stats;
  const out = ["### Host telemetry", ""];
  out.push(`- **Result:** ${r.result.result ?? "unknown"}; **duration:** ${fmtDur(w.endMs - w.startMs)}${w.open ? " so far" : ""}`);
  out.push(`- **Memory pressure:** peak ${fmtPressure(s.pressure.peak)}; **swap change:** ${fmtSigned(s.swap.change, " MB")}; **peak load:** ${fmtNum(s.load.peak)} on ${fmtNum(s.load.cores)} cores`);
  const cpu = topGroups(r, "cpuSeconds").map((x) => `${GROUP_LABELS[x.g]} ${x.cpuSeconds}s`);
  const rss = topGroups(r, "peakRssMb").map((x) => `${GROUP_LABELS[x.g]} ${x.peakRssMb} MB`);
  out.push(`- **Top CPU:** ${cpu.length ? cpu.join(", ") : "unavailable"}; **top peak RSS:** ${rss.length ? rss.join(", ") : "unavailable"}`);
  const b = r.baseline;
  if (!b || b.sampleCount === 0) out.push("- **Baseline:** unavailable");
  else {
    out.push(`- **Baseline:** ${b.startedUnderPressure ? `STARTED UNDER PRESSURE (${b.reason})` : "not started under pressure"}`);
    const left = [...b.processes.map(procName), ...b.leftoverDevices.map((d) => `device ${d}`)];
    const running = b.openAtStart.map((o) => o.label);
    out.push(`- **Leftovers at start:** ${left.length ? left.join(", ") : "none"}${running.length ? `; already running: ${running.join("; ")}` : ""}`);
    if (b.likelyCause) out.push(`- ${likelyCauseLine(b)}`);
  }
  const files = [...r.snapshots.map((x) => x.name), ...r.crashReports.map((x) => path.basename(x.file))];
  out.push(`- **Snapshots/crash reports:** ${files.length ? files.join(", ") : "none"}`);
  out.push(`- **Sampling gaps:** ${r.gaps.length ? r.gaps.slice(0, 3).map((g) => `${fmtTime(g.fromMs)} (${fmtDur(g.durationMs)})`).join(", ") + (r.gaps.length > 3 ? `, +${r.gaps.length - 3} more` : "") : "none"}`);
  for (const x of r.wedge) out.push(`- ${wedgeLine(x)}`);
  for (const i of r.noJobIntervals) out.push(`- ${noJobLine(i)}`);
  out.push("", `_${ADMIN_REMINDER}_`);
  return out.join("\n");
}

export function renderUnavailable(reason) {
  return `Telemetry summary unavailable: ${reason}. ${ADMIN_REMINDER}`;
}
