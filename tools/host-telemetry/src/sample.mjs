// Builds one telemetry sample from injected command output. MOV-494.
import os from "node:os";
import {
  hasBusyProcess, parseDfFreeGb, parsePmsetTherm, parsePs, parseSwapUsage, parseSysctlInt,
  parseVmStat, rollup, topBy,
} from "./parse.mjs";

export const COMMAND_TIMEOUT_MS = 3000;

export const COMMANDS = {
  ps: ["/bin/ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="]],
  vmStat: ["/usr/bin/vm_stat", []],
  pressure: ["/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]],
  swap: ["/usr/sbin/sysctl", ["vm.swapusage"]],
  therm: ["/usr/bin/pmset", ["-g", "therm"]],
  df: ["/bin/df", ["-k", "/"]],
};

// run(cmd, args, { timeoutMs }) -> { ok, stdout, timedOut }
export async function collectSample({ run, nowMs, cores = os.cpus().length, loadavg = os.loadavg() }) {
  const names = Object.keys(COMMANDS);
  const results = await Promise.all(
    names.map((name) => run(COMMANDS[name][0], COMMANDS[name][1], { timeoutMs: COMMAND_TIMEOUT_MS })),
  );
  const out = Object.fromEntries(names.map((n, i) => [n, results[i]]));
  const notes = names
    .filter((n) => !out[n].ok)
    .map((n) => (out[n].timedOut ? `${n}: timed out after ${COMMAND_TIMEOUT_MS}ms, skipped` : `${n}: failed`));
  const text = (n) => (out[n].ok ? out[n].stdout : "");
  const procs = out.ps.ok ? parsePs(out.ps.stdout) : [];
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
    topCpu: topBy(procs, "cpu"),
    topRss: topBy(procs, "rssMb"),
    groups: rollup(procs),
    busyProcess: hasBusyProcess(procs),
    notes,
  };
}
