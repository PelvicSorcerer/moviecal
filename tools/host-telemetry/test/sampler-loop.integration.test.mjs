import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_REMINDER } from "../src/common.mjs";
import { main } from "../src/cli.mjs";
import { runCommand } from "../src/exec.mjs";
import { runLoop } from "../src/loop.mjs";
import { appendMarker } from "../src/markers.mjs";
import { fakeRunner } from "./fixtures.mjs";

const START = Date.UTC(2026, 0, 1);
const IDLE_PS = "  1  0  0.5  12000 /sbin/launchd\n";

function fakeClock(start) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

function readSamples(dir, day) {
  const lines = fs.readFileSync(path.join(dir, `samples-${day}.jsonl`), "utf8").trim().split("\n");
  return { header: JSON.parse(lines[0]), samples: lines.slice(1).map((l) => JSON.parse(l)) };
}

describe("sampler loop", () => {
  it("samples every 5s idle and 1.5s busy across a day, surviving a hung command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-int-"));
    const clock = fakeClock(START);
    // Busy window 06:00-06:10 via marker; hung `pmset` 12:00-12:05.
    const busyFrom = START + 6 * 3600_000;
    appendMarker({ source: "runner", event: "job-start", id: "j" }, { dir, now: () => busyFrom });
    appendMarker({ source: "runner", event: "job-end", id: "j" }, { dir, now: () => busyFrom + 600_000 });
    const run = (cmd, args, o) => {
      const hang = clock.now() >= START + 12 * 3600_000 && clock.now() < START + 12 * 3600_000 + 300_000;
      return fakeRunner({ ps: IDLE_PS, pmset: hang ? "hang" : "ok" })(cmd, args, o);
    };
    await runLoop({ run, clock, dir, cores: 8, loadavg: () => [0.5, 0.5, 0.5], shouldStop: () => clock.now() >= START + 24 * 3600_000 });
    const { header, samples } = readSamples(dir, "2026-01-01");
    expect(header.note).toBe(ADMIN_REMINDER);
    const gaps = (from, to) => {
      const ts = samples.map((s) => Date.parse(s.t)).filter((t) => t >= from && t < to);
      return new Set(ts.slice(1).map((t, i) => t - ts[i]));
    };
    expect([...gaps(START, busyFrom - 10_000)]).toEqual([5000]);
    expect([...gaps(busyFrom + 5000, busyFrom + 590_000)]).toEqual([1500]);
    expect([...gaps(START + 13 * 3600_000, START + 14 * 3600_000)]).toEqual([5000]);
    const hung = samples.filter((s) => s.notes.length);
    expect(hung.length).toBeGreaterThanOrEqual(59);
    expect(hung.length).toBeLessThanOrEqual(61);
    expect(samples.length).toBeGreaterThan(16000);
    expect(fs.existsSync(path.join(dir, "snapshots"))).toBe(false);
  }, 120_000);

  it("goes busy on a running xcodebuild and takes one rate-limited snapshot on critical pressure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-int-"));
    const clock = fakeClock(START);
    const calls = [];
    const stopAt = START + 20 * 60_000;
    await runLoop({
      run: fakeRunner({ pressure: 4 }, calls), clock, dir, cores: 8, loadavg: () => [1, 1, 1],
      shouldStop: () => clock.now() >= stopAt,
    });
    const { samples } = readSamples(dir, "2026-01-01");
    expect(samples[0].busy).toBe(true);
    expect(Date.parse(samples[1].t) - Date.parse(samples[0].t)).toBe(1500);
    expect(fs.readdirSync(path.join(dir, "snapshots"))).toHaveLength(4);
    expect(calls.filter((c) => c.name === "vm_stat" && c.args.length === 0).length).toBeGreaterThan(0);
  });
});

describe("runCommand", () => {
  it("kills a hung command at its timeout", async () => {
    const started = Date.now();
    const r = await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it("reports a missing executable without throwing", async () => {
    expect((await runCommand("/nonexistent/binary", [], { timeoutMs: 500 })).ok).toBe(false);
  });
});

describe("--once", () => {
  it("prints the admin reminder and one full sample", async () => {
    const lines = [];
    const code = await main(["--once"], { run: fakeRunner(), out: (l) => lines.push(l), dir: os.tmpdir() });
    expect(code).toBe(0);
    expect(lines[0]).toBe(ADMIN_REMINDER);
    expect(JSON.parse(lines[1])).toHaveProperty("groups");
  });
});
