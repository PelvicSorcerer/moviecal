// Builds one telemetry sample from injected command output. MOV-494.
import os from "node:os";
import { COMMAND_TIMEOUT_MS, createCommandCache } from "./cache.mjs";
import {
  hasBusyProcess, parseDfFreeGb, processCounts, parsePmsetTherm, parsePs, parseSwapUsage, parseSysctlInt,
  parseVmStat, rollup, topBy,
} from "./parse.mjs";

export const COMMANDS = {
  ps: ["/bin/ps", ["-axo", "pid=,ppid=,pcpu=,rss=,state=,comm="]],
  vmStat: ["/usr/bin/vm_stat", []],
  pressure: ["/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]],
  swap: ["/usr/sbin/sysctl", ["vm.swapusage"]],
  therm: ["/usr/bin/pmset", ["-g", "therm"]],
  df: ["/bin/df", ["-k", "/"]],
};

export { COMMAND_TIMEOUT_MS };

// cache: createCommandCache(...) kept across samples by the loop. Without one (tests, --once) a fresh cache is
// used and every command runs once. Fields whose command failed, timed out or is not back yet are null and noted.
export async function collectSample({ run, nowMs, cores = os.cpus().length, loadavg = os.loadavg(), cpu = () => null, cache, busy = false }) {
  const names = Object.keys(COMMANDS);
  const c = cache ?? createCommandCache({ run, commands: COMMANDS });
  await c.refresh(nowMs, { busy, wait: cache ? undefined : COMMAND_TIMEOUT_MS + 1000 });
  const out = Object.fromEntries(names.map((n) => [n, c.get(n, nowMs)]));
  const notes = names
    .filter((n) => !out[n].ok)
    .map((n) => {
      if (out[n].timedOut) return `${n}: timed out after ${COMMAND_TIMEOUT_MS}ms, skipped`;
      if (out[n].pending) return `${n}: no result yet, skipped`;
      if (out[n].stale) return `${n}: result too old, skipped`;
      return `${n}: failed`;
    });
  const text = (n) => (out[n].ok ? out[n].stdout : "");
  const procs = out.ps.ok ? parsePs(out.ps.stdout) : [];
  const counts = out.ps.ok ? processCounts(procs) : null;
  if (!out.ps.ok) notes.push("ps unavailable: process fields (runnable, simProcs, xpcproxySim, topCpu, topRss, groups) are null");
  const vm = out.vmStat.ok ? parseVmStat(text("vmStat")) : { freeMb: null, compressorMb: null };
  const therm = out.therm.ok ? parsePmsetTherm(text("therm")) : { speedLimit: null, warning: "unknown" };
  const pressure = out.pressure.ok ? parseSysctlInt(text("pressure")) : null;
  return {
    t: new Date(nowMs).toISOString(),
    pressure,
    freeMb: vm.freeMb,
    compressorMb: vm.compressorMb,
    swapUsedMb: out.swap.ok ? parseSwapUsage(text("swap")) : null,
    load: loadavg.map((n) => Math.round(n * 100) / 100),
    cores,
    thermal: therm,
    diskFreeGb: out.df.ok ? parseDfFreeGb(text("df")) : null,
    cpu: cpu(),
    runnable: counts?.runnable ?? null,
    simProcs: counts?.simProcs ?? null,
    xpcproxySim: counts?.xpcproxySim ?? null,
    topCpu: counts ? topBy(procs, "cpu") : null,
    topRss: counts ? topBy(procs, "rssMb") : null,
    groups: counts ? rollup(procs) : null,
    busyProcess: counts ? hasBusyProcess(procs) : null,
    runnerWorker: counts ? counts.runnerWorker : null,
    notes,
  };
}
