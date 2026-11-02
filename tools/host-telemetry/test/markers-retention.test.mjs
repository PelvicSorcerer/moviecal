import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_REMINDER } from "../src/common.mjs";
import { appendMarker, hasOpenMarker, openMarkers, readMarkers } from "../src/markers.mjs";
import { applyRetention } from "../src/retention.mjs";
import { pruneSnapshots, takeSnapshot } from "../src/snapshot.mjs";
import { fakeRunner } from "./fixtures.mjs";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-unit-"));
});

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);

describe("markers", () => {
  it("writes the documented schema with a header and reads it back", () => {
    appendMarker({ source: "runner", event: "job-start", id: "1" }, { dir, now: () => T0 });
    appendMarker({ source: "runner", event: "job-end", id: "1", t: "ignored" }, { dir, now: () => T0 + 1000 });
    const file = path.join(dir, "markers-2026-01-10.jsonl");
    expect(fs.readFileSync(file, "utf8").split("\n")[0]).toContain(ADMIN_REMINDER);
    const read = readMarkers({ dir, sinceMs: T0 - 1, untilMs: T0 + 5000 });
    expect(read).toEqual([
      { t: "2026-01-10T12:00:00.000Z", source: "runner", event: "job-start", id: "1" },
      { t: "2026-01-10T12:00:01.000Z", source: "runner", event: "job-end", id: "1" },
    ]);
    expect(() => appendMarker({ source: "bogus", event: "x" }, { dir })).toThrow();
  });
  it("busy follows an open start marker and ignores stale ones", () => {
    appendMarker({ source: "runner", event: "job-start", id: "1" }, { dir, now: () => T0 });
    expect(hasOpenMarker({ dir, nowMs: T0 + 60_000 })).toBe(true);
    appendMarker({ source: "runner", event: "job-end", id: "1" }, { dir, now: () => T0 + 1000 });
    expect(hasOpenMarker({ dir, nowMs: T0 + 60_000 })).toBe(false);
    appendMarker({ source: "dispatcher", event: "worker-start", id: "w" }, { dir, now: () => T0 });
    expect(hasOpenMarker({ dir, nowMs: T0 + 5 * 3600_000 })).toBe(true);
    expect(hasOpenMarker({ dir, nowMs: T0 + 7 * 3600_000 })).toBe(false);
  });
  it("sampler events never open spans", () => {
    expect(openMarkers([{ t: "x", source: "sampler", event: "sampler-start" }])).toEqual([]);
  });
});

describe("retention", () => {
  it("gzips after one day and deletes after 14", () => {
    const now = Date.UTC(2026, 0, 20, 3);
    for (const d of ["2026-01-20", "2026-01-19", "2026-01-06", "2026-01-05"]) {
      fs.writeFileSync(path.join(dir, `samples-${d}.jsonl`), "{}\n");
    }
    const r = applyRetention(dir, now);
    expect(r.deleted).toEqual(["samples-2026-01-05.jsonl"]);
    expect(r.gzipped.sort()).toEqual(["samples-2026-01-06.jsonl", "samples-2026-01-19.jsonl"]);
    expect(fs.existsSync(path.join(dir, "samples-2026-01-20.jsonl"))).toBe(true);
    expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "samples-2026-01-19.jsonl.gz"))).toString()).toBe("{}\n");
    expect(fs.existsSync(path.join(dir, "samples-2026-01-19.jsonl"))).toBe(false);
  });
  it("reads gzipped marker files", () => {
    appendMarker({ source: "runner", event: "job-start", id: "1" }, { dir, now: () => T0 });
    applyRetention(dir, T0 + 36 * 3600_000);
    expect(readMarkers({ dir, sinceMs: T0 - 1, untilMs: T0 + 1 })).toHaveLength(1);
  });
});

describe("snapshot", () => {
  it("writes a headered file with every section, bounded timeouts, and caps files", async () => {
    const calls = [];
    const file = await takeSnapshot({ run: fakeRunner({ sample: "hang" }, calls), dir, nowMs: T0, reasons: ["critical"] });
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain(ADMIN_REMINDER);
    expect(text).toContain("process tree");
    expect(text).toContain("vm_stat");
    expect(text).toContain("timed out, skipped");
    expect(calls.filter((c) => c.name === "sample")).toHaveLength(3);
    expect(calls.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 20_000)).toBe(true);
    const snaps = path.join(dir, "snapshots");
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(snaps, `snapshot-2026-01-0${(i % 9) + 1}T00-00-${String(i).padStart(2, "0")}.txt`), "x");
    pruneSnapshots(snaps);
    expect(fs.readdirSync(snaps)).toHaveLength(20);
  });
});
