import { describe, expect, it } from "vitest";
import { SnapshotGate, TriggerState, computeLoadNoJob } from "../src/triggers.mjs";

const base = { pressure: 1, swapUsedMb: 1000, load: [1, 1, 1], cores: 8, thermal: { speedLimit: 100 }, diskFreeGb: 50 };
const s = (o) => ({ ...base, ...o });

describe("TriggerState", () => {
  it("does not fire on a single or steady warn reading", () => {
    const t = new TriggerState();
    expect(t.observe(s({ pressure: 2 }), 0)).toEqual([]);
    expect(t.observe(s({ pressure: 2 }), 120_000)).toEqual([]);
  });
  it("fires on sustained warn plus swap growth, and resets when pressure clears", () => {
    const t = new TriggerState();
    t.observe(s({ pressure: 2 }), 0);
    expect(t.observe(s({ pressure: 2, swapUsedMb: 1100 }), 30_000)).toEqual([]);
    expect(t.observe(s({ pressure: 2, swapUsedMb: 1100 }), 60_000)).toHaveLength(1);
    t.observe(s({ pressure: 1 }), 61_000);
    expect(t.observe(s({ pressure: 2, swapUsedMb: 5000 }), 62_000)).toEqual([]);
  });
  it("fires on critical, thermal, low disk", () => {
    const t = new TriggerState();
    expect(t.observe(s({ pressure: 4 }), 0)[0]).toMatch(/critical/);
    expect(t.observe(s({ thermal: { speedLimit: 80 } }), 0)[0]).toMatch(/thermal/);
    expect(t.observe(s({ diskFreeGb: 9 }), 0)[0]).toMatch(/disk/);
  });
  it("fires on load above 2x cores only after 1 minute", () => {
    const t = new TriggerState();
    expect(t.observe(s({ load: [17, 1, 1] }), 0)).toEqual([]);
    expect(t.observe(s({ load: [17, 1, 1] }), 60_000)[0]).toMatch(/load/);
    t.observe(s({ load: [1, 1, 1] }), 61_000);
    expect(t.observe(s({ load: [17, 1, 1] }), 62_000)).toEqual([]);
  });
});

describe("loadNoJob", () => {
  const hi = { load: [17, 1, 1], cores: 8, runnerWorker: false, markerBusy: false };
  it("is true only for high load with no Runner.Worker and no open marker", () => {
    expect(computeLoadNoJob(hi)).toBe(true);
    expect(computeLoadNoJob({ ...hi, runnerWorker: true })).toBe(false);
    expect(computeLoadNoJob({ ...hi, markerBusy: true })).toBe(false);
    expect(computeLoadNoJob({ ...hi, load: [3, 1, 1] })).toBe(false);
    expect(computeLoadNoJob({ ...hi, runnerWorker: null })).toBeNull();
    expect(computeLoadNoJob({ ...hi, runnerWorker: null, markerBusy: true })).toBe(false);
  });
  it("adds a trigger reason only after the sustain window and resets", () => {
    const t = new TriggerState();
    const noJob = s({ load: [17, 1, 1], loadNoJob: true });
    expect(t.observe(noJob, 0)).not.toContain("high load with no job running");
    expect(t.observe(noJob, 60_000)).toContain("high load with no job running");
    t.observe(s({ load: [17, 1, 1], loadNoJob: false }), 61_000);
    expect(t.observe(noJob, 62_000)).not.toContain("high load with no job running");
  });
});

describe("SnapshotGate", () => {
  it("rate limits to one per 5 minutes and never overlaps", () => {
    const g = new SnapshotGate();
    expect(g.tryStart(0)).toBe(true);
    expect(g.tryStart(400_000)).toBe(false);
    g.finish();
    expect(g.tryStart(200_000)).toBe(false);
    expect(g.tryStart(300_000)).toBe(true);
  });
});
