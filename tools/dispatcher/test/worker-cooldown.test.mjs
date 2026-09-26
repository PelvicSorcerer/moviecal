import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKERS, WorkerCooldownStore } from "../src/worker-cooldown.mjs";

const NOW = new Date("2026-09-25T02:06:00.000Z");
const RESET = "2026-09-25T07:06:00.000Z"; // 5-hour Claude session limit

describe("WorkerCooldownStore", () => {
  let tmpRoot;
  let statePath;
  let store;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-cooldown-test-"));
    statePath = path.join(tmpRoot, "config", "worker-cooldowns.json");
    store = new WorkerCooldownStore(statePath);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports no cooldown for a worker with no history", () => {
    expect(store.state("claude", NOW)).toEqual({ worker: "claude", cooling: false, probeOwed: false, resetAt: null, evidence: null });
    expect(store.get("claude")).toBeNull();
  });

  it("cools down until the recorded reset, then owes exactly one probe", () => {
    store.record("claude", { resetAt: RESET, evidence: "5-hour session limit reached", now: NOW });

    expect(store.state("claude", NOW)).toMatchObject({ cooling: true, probeOwed: false, resetAt: RESET });
    expect(store.state("claude", new Date("2026-09-25T07:05:59.999Z"))).toMatchObject({ cooling: true });

    const after = new Date("2026-09-25T07:06:00.001Z");
    expect(store.state("claude", after)).toMatchObject({ cooling: false, probeOwed: true, resetAt: RESET });
  });

  it("isolates one worker's cooldown from the other's (provider independence)", () => {
    store.record("claude", { resetAt: RESET, now: NOW });
    expect(store.state("claude", NOW).cooling).toBe(true);
    expect(store.state("codex", NOW)).toMatchObject({ cooling: false, probeOwed: false });
  });

  it("survives a restart", () => {
    store.record("claude", { resetAt: RESET, evidence: "session limit", now: NOW });
    const restarted = new WorkerCooldownStore(statePath);
    expect(restarted.state("claude", NOW)).toMatchObject({ cooling: true, resetAt: RESET });
  });

  it("refreshes an existing cooldown to a newly reported reset (a second recognized limit before the first reset)", () => {
    store.record("claude", { resetAt: RESET, evidence: "first limit", now: NOW });
    const laterReset = "2026-09-25T09:00:00.000Z";
    store.record("claude", { resetAt: laterReset, evidence: "second limit", now: NOW });

    expect(store.state("claude", NOW)).toMatchObject({ cooling: true, resetAt: laterReset, evidence: "second limit" });
  });

  it("clear() closes the cooldown -- a clean or otherwise-resolved probe", () => {
    store.record("claude", { resetAt: RESET, now: NOW });
    store.clear("claude");
    expect(store.get("claude")).toBeNull();
    expect(store.state("claude", NOW)).toMatchObject({ cooling: false, probeOwed: false });
  });

  it("clear() on a worker with no cooldown is a no-op", () => {
    expect(() => store.clear("codex")).not.toThrow();
    expect(store.get("codex")).toBeNull();
  });

  it("reads an unparseable resetAt as no cooldown at all, rather than cooling forever", () => {
    store.record("claude", { resetAt: "not-a-real-date", now: NOW });
    expect(store.state("claude", NOW)).toMatchObject({ cooling: false, probeOwed: false, resetAt: null });
  });

  it("WORKERS names exactly the two supported quota pools", () => {
    expect(WORKERS).toEqual(["claude", "codex"]);
  });
});
