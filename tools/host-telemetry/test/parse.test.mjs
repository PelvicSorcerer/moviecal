import { describe, expect, it } from "vitest";
import {
  groupOf, parseDfFreeGb, parsePmsetTherm, parsePs, parseSwapUsage, parseSysctlInt, parseVmStat, rollup,
  sanitizeCommand, topBy,
} from "../src/parse.mjs";
import { collectSample } from "../src/sample.mjs";
import { DF, PS_FIXTURE, THERM_LIMITED, THERM_NONE, VM_STAT, fakeRunner } from "./fixtures.mjs";

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
