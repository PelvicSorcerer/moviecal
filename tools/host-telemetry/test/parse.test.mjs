import { describe, expect, it } from "vitest";
import {
  cpuSplit, createCpuSampler, groupOf, parseDfFreeGb, processCounts, parsePmsetTherm, parsePs, parseSwapUsage, parseSysctlInt, parseVmStat, rollup,
  sanitizeCommand, topBy,
} from "../src/parse.mjs";
import { collectSample } from "../src/sample.mjs";
import { DF, PS_FIXTURE, STALE_SIM_PS, THERM_LIMITED, THERM_NONE, VM_STAT, fakeRunner } from "./fixtures.mjs";

describe("parsers", () => {
  it("parses vm_stat with the reported page size", () => {
    expect(parseVmStat(VM_STAT)).toEqual({ freeMb: 62.5, compressorMb: 3125 });
  });
  it("parses sysctl, swap, pmset and df", () => {
    expect(parseSysctlInt("2\n")).toBe(2);
    expect(parseSwapUsage("total = 3072.00M  used = 2764.50M  free = 307.50M  (encrypted)")).toBe(2764.5);
    expect(parseSwapUsage("garbage")).toBeNull();
    expect(parsePmsetTherm(THERM_NONE).speedLimit).toBe(100);
    expect(parsePmsetTherm(THERM_LIMITED).speedLimit).toBe(70);
    expect(parseDfFreeGb(DF)).toBe(40);
  });
});

describe("ps grouping", () => {
  const procs = parsePs(PS_FIXTURE);
  it("attributes each process to its group", () => {
    expect(procs).toHaveLength(10);
    const g = rollup(procs);
    expect(g.runner).toEqual({ count: 1, cpu: 42, rssMb: 146.5 });
    expect(g.xcode.count).toBe(2);
    expect(g.simulator.count).toBe(2);
    expect(g.workers.count).toBe(2);
    expect(g.node.count).toBe(1);
    expect(g.other.count).toBe(2);
    expect(g.xcode.cpu).toBe(92.5);
  });
  it("orders top lists", () => {
    expect(topBy(procs, "cpu", 2).map((p) => p.pid)).toEqual([101, 105]);
    expect(topBy(procs, "rssMb", 1)[0].pid).toBe(101);
  });
  it("groups by executable", () => {
    expect(groupOf("/usr/bin/node")).toBe("node");
    expect(groupOf("/x/Runner.Worker")).toBe("runner");
  });
});

describe("redaction", () => {
  it("drops arguments and token-like words and truncates", () => {
    const out = JSON.stringify(parsePs(PS_FIXTURE));
    expect(out).not.toMatch(/ghp_|sk-live|SECRET_TOKEN|abcdefghijklmnop|--token|scheme/);
    expect(sanitizeCommand("sk-live_abcdefghijklmnop1234")).toBe("[redacted]");
    expect(sanitizeCommand("/bin/x " + "a".repeat(500)).length).toBeLessThanOrEqual(100);
    expect(sanitizeCommand("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toContain("Google Chrome");
  });
});

describe("collectSample", () => {
  it("includes every required field", async () => {
    const s = await collectSample({ run: fakeRunner({ pressure: 2 }), nowMs: Date.UTC(2026, 0, 1, 0, 0, 0, 123), cores: 8, loadavg: [1.234, 2, 3] });
    expect(s.t).toBe("2026-01-01T00:00:00.123Z");
    expect(s).toMatchObject({
      pressure: 2, freeMb: 62.5, compressorMb: 3125, swapUsedMb: 2000, load: [1.23, 2, 3], cores: 8, diskFreeGb: 40,
      thermal: { speedLimit: 100 }, busyProcess: true, notes: [],
    });
    expect(s.topCpu).toHaveLength(10);
    expect(s.topRss.length).toBeLessThanOrEqual(15);
    expect(Object.keys(s.groups)).toEqual(["runner", "xcode", "simulator", "workers", "node", "other"]);
  });
  it("notes a hung command and still returns a sample", async () => {
    const s = await collectSample({ run: fakeRunner({ pmset: "hang" }), nowMs: 0, cores: 8, loadavg: [0, 0, 0] });
    expect(s.notes).toEqual([expect.stringContaining("therm: timed out")]);
    expect(s.thermal.speedLimit).toBeNull();
    expect(s.freeMb).toBe(62.5);
  });
});

describe("ps state, simulator counts and CPU split", () => {
  it("parses the state column and counts runnable processes", () => {
    const procs = parsePs(PS_FIXTURE);
    expect(procs.map((p) => p.state)).toContain("R+");
    expect(processCounts(procs)).toMatchObject({ runnable: 3, simProcs: 1, xpcproxySim: 0, runnerWorker: true });
  });
  it("counts simulator processes and xpcproxy_sim separately", () => {
    expect(processCounts(parsePs(STALE_SIM_PS))).toEqual({ runnable: 2, simProcs: 2, xpcproxySim: 2, runnerWorker: false });
  });
  it("counts xpcproxy_sim and Runner.Worker from long and spaced real-world paths", () => {
    const rt = "/Library/Developer/CoreSimulator/Volumes/iOS_22C150/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.2.simruntime/Contents/Resources/RuntimeRoot";
    const text = ` 300 1 1.0 1000 R  ${rt}/usr/libexec/xpcproxy_sim\n 301 1 1.0 1000 S  ${rt}/sbin/launchd_sim\n 302 1 1.0 1000 S  /Users/adammoore/actions-runner/bin/Runner.Worker\n`;
    expect(processCounts(parsePs(text))).toEqual({ runnable: 1, simProcs: 1, xpcproxySim: 1, runnerWorker: true });
  });
  it("computes the CPU split from os.cpus() deltas", () => {
    const at = (user, sys, idle) => [{ times: { user, nice: 0, sys, idle, irq: 0 } }, { times: { user, nice: 0, sys, idle, irq: 0 } }];
    expect(cpuSplit(at(0, 0, 0), at(300, 540, 160))).toEqual({ user: 30, sys: 54, idle: 16 });
    expect(cpuSplit(at(5, 5, 5), at(5, 5, 5))).toBeNull();
    const readings = [at(0, 0, 0), at(10, 10, 80)];
    const sampler = createCpuSampler(() => readings.shift());
    expect(sampler()).toBeNull();
    expect(sampler()).toEqual({ user: 10, sys: 10, idle: 80 });
  });
  it("adds the new fields to a sample", async () => {
    const cpu = () => ({ user: 30, sys: 54, idle: 16 });
    const s = await collectSample({ run: fakeRunner({ ps: STALE_SIM_PS }), nowMs: 0, cores: 8, loadavg: [1, 1, 1], cpu });
    expect(s).toMatchObject({ runnable: 2, simProcs: 2, xpcproxySim: 2, cpu: { user: 30, sys: 54, idle: 16 }, busyProcess: true });
  });
  it("keeps non-ps fields and nulls ps fields when ps times out", async () => {
    const s = await collectSample({ run: fakeRunner({ ps: "hang" }), nowMs: 0, cores: 8, loadavg: [9, 9, 9], cpu: () => ({ user: 1, sys: 2, idle: 97 }) });
    expect(s).toMatchObject({
      runnable: null, simProcs: null, xpcproxySim: null, topCpu: null, topRss: null, groups: null, busyProcess: null,
      pressure: 1, swapUsedMb: 2000, freeMb: 62.5, diskFreeGb: 40, load: [9, 9, 9], cpu: { user: 1, sys: 2, idle: 97 },
    });
    expect(s.notes.some((n) => n.startsWith("ps:"))).toBe(true);
  });
});
