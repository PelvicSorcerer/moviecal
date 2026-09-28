import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CircuitBreakerStore, DEFAULT_PROBE_BACKOFF, describeBreakers, probeDelayMs, runBreakerCommand } from "../src/circuit-breaker.mjs";

describe("CircuitBreakerStore", () => {
  let tmpRoot;
  let statePath;
  let store;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-circuit-breaker-test-"));
    statePath = path.join(tmpRoot, "config", "circuit-breakers.json");
    store = new CircuitBreakerStore(statePath);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("is closed by default when no state file exists", () => {
    expect(store.isOpen("nested-sandbox-crash")).toBe(false);
  });

  it("opens after trip() and is reflected by a fresh store instance reading the same path", () => {
    store.trip("nested-sandbox-crash", "worker exited 71 with the nested-sandbox-crash signature");

    expect(store.isOpen("nested-sandbox-crash")).toBe(true);
    expect(new CircuitBreakerStore(statePath).isOpen("nested-sandbox-crash")).toBe(true);
  });

  it("persists the reason and a trippedAt timestamp", () => {
    store.trip("nested-sandbox-crash", "worker exited 71 with the nested-sandbox-crash signature");

    const state = store.load();
    expect(state["nested-sandbox-crash"]).toMatchObject({
      open: true,
      reason: "worker exited 71 with the nested-sandbox-crash signature",
    });
    expect(state["nested-sandbox-crash"].trippedAt).toEqual(expect.any(String));
  });

  it("closes after clear()", () => {
    store.trip("nested-sandbox-crash", "some reason");
    store.clear("nested-sandbox-crash");

    expect(store.isOpen("nested-sandbox-crash")).toBe(false);
  });

  it("clear() on an already-closed (or never-tripped) breaker is a no-op", () => {
    expect(() => store.clear("nested-sandbox-crash")).not.toThrow();
    expect(store.isOpen("nested-sandbox-crash")).toBe(false);
  });

  it("keeps named breakers independent of one another", () => {
    store.trip("nested-sandbox-crash", "reason a");

    expect(store.isOpen("nested-sandbox-crash")).toBe(true);
    expect(store.isOpen("some-other-breaker")).toBe(false);
  });

  it("writes state atomically with a .bak recovery copy", () => {
    store.trip("nested-sandbox-crash", "reason a");
    store.trip("nested-sandbox-crash", "reason b");

    expect(fs.existsSync(`${statePath}.bak`)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(`${statePath}.bak`, "utf8"));
    expect(backup["nested-sandbox-crash"].reason).toBe("reason a");
  });

  it("recovers from the .bak file when the primary state file is corrupt", () => {
    store.trip("nested-sandbox-crash", "good state");
    // A second trip produces a .bak equal to the first write; corrupt the primary.
    store.trip("nested-sandbox-crash", "good state again");
    fs.writeFileSync(statePath, "{not valid json", "utf8");

    expect(store.load()["nested-sandbox-crash"].reason).toBe("good state");
  });

  describe("persisted probe schedule (MOV-403)", () => {
    const T0 = Date.parse("2026-09-27T23:16:40.000Z");
    const MIN = 60 * 1000;
    let clock;
    let scheduled;
    const now = () => new Date(clock);

    beforeEach(() => {
      clock = T0;
      scheduled = new CircuitBreakerStore(statePath, { now });
    });

    it("grows the delay geometrically and caps it", () => {
      expect([0, 1, 2, 3, 4, 5, 6].map((n) => probeDelayMs(n) / MIN)).toEqual([10, 20, 40, 80, 160, 240, 240]);
    });

    it("sets an explicit next-probe deadline on the first trip and is not due before it", () => {
      const result = scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex", issue: "MOV-1" });

      expect(result).toMatchObject({ firstTrip: true, repeatNotice: false, nextProbeAt: "2026-09-27T23:26:40.000Z" });
      clock = T0 + 10 * MIN - 1;
      expect(scheduled.status("nested-sandbox-crash")).toMatchObject({ open: true, due: false, adapter: "codex", failedProbes: 0 });
      clock = T0 + 10 * MIN;
      expect(scheduled.status("nested-sandbox-crash").due).toBe(true);
    });

    it("counts a claimed probe as failed up front, persisting a later deadline that a restart preserves", () => {
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex" });
      clock = T0 + 10 * MIN;
      scheduled.claimProbe("nested-sandbox-crash", { issue: "MOV-2" });

      const restarted = new CircuitBreakerStore(statePath, { now });
      expect(restarted.status("nested-sandbox-crash")).toMatchObject({
        due: false,
        failedProbes: 1,
        nextProbeAt: "2026-09-27T23:46:40.000Z",
        probe: { issue: "MOV-2", startedAt: "2026-09-27T23:26:40.000Z", operatorAuthorized: false },
      });
    });

    it("measures a failed probe's backoff from the failure, never earlier, and keeps the original trippedAt", () => {
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex" });
      clock = T0 + 10 * MIN;
      scheduled.claimProbe("nested-sandbox-crash");
      clock = T0 + 11 * MIN;
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex" });

      const status = scheduled.status("nested-sandbox-crash");
      expect(status.nextProbeAt).toBe("2026-09-27T23:47:40.000Z");
      expect(status.trippedAt).toBe("2026-09-27T23:16:40.000Z");
      expect(status.lastFailureAt).toBe("2026-09-27T23:27:40.000Z");
    });

    it("stops automatic probes after the bounded budget until an operator authorizes one", () => {
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex" });
      for (let i = 0; i < DEFAULT_PROBE_BACKOFF.maxAutoProbes; i += 1) {
        clock = Date.parse(scheduled.status("nested-sandbox-crash").nextProbeAt);
        scheduled.claimProbe("nested-sandbox-crash");
      }
      clock += 365 * 24 * 60 * MIN;
      expect(scheduled.status("nested-sandbox-crash")).toMatchObject({ due: false, exhausted: true, nextProbeAt: null });

      scheduled.authorizeProbe("nested-sandbox-crash", { by: "adam" });
      expect(scheduled.status("nested-sandbox-crash")).toMatchObject({ due: true, operatorProbe: { by: "adam" } });
      scheduled.claimProbe("nested-sandbox-crash");
      const after = scheduled.status("nested-sandbox-crash");
      expect(after).toMatchObject({ due: false, exhausted: true, operatorProbe: null, failedProbes: DEFAULT_PROBE_BACKOFF.maxAutoProbes + 1 });
    });

    it("reports a repeat notice only for the same issue with unchanged evidence", () => {
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex", issue: "MOV-1" });
      expect(scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex", issue: "MOV-1" }).repeatNotice).toBe(true);
      expect(scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex", issue: "MOV-2" }).repeatNotice).toBe(false);
      expect(scheduled.trip("nested-sandbox-crash", "exit 0 narrated", { adapter: "codex", issue: "MOV-2" }).repeatNotice).toBe(false);
    });

    it("recovers only on the affected adapter's evidence", () => {
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex" });

      expect(scheduled.recover("nested-sandbox-crash", { adapter: "claude", evidence: "claude Bash ok" })).toBe(false);
      expect(scheduled.isOpen("nested-sandbox-crash")).toBe(true);
      expect(scheduled.recover("nested-sandbox-crash", { adapter: "codex", evidence: "codex exited 0" })).toBe(true);
      expect(scheduled.load()["nested-sandbox-crash"]).toMatchObject({ open: false, recoveredBy: { adapter: "codex", evidence: "codex exited 0" } });
    });

    it("keeps credential and sandbox conditions independent", () => {
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex" });
      scheduled.trip("credential-failure", "401", { adapter: "claude" });

      scheduled.recover("credential-failure", { adapter: "claude", evidence: "clean worker exit" });
      expect(scheduled.isOpen("credential-failure")).toBe(false);
      expect(scheduled.isOpen("nested-sandbox-crash")).toBe(true);
    });

    it("authorizing a probe on a closed breaker does nothing", () => {
      expect(scheduled.authorizeProbe("nested-sandbox-crash")).toBeNull();
      expect(scheduled.load()).toEqual({});
    });

    it("describes each breaker's adapter, reason and actual retry time for operators", () => {
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex" });
      const [sandbox, credential] = describeBreakers(scheduled, ["nested-sandbox-crash", "credential-failure"]);

      expect(sandbox.line).toContain("OPEN on codex");
      expect(sandbox.line).toContain("not before 2026-09-27T23:26:40.000Z");
      expect(credential.line).toBe("credential-failure: closed");
    });

    it("breaker probe-now authorizes one probe and keeps history; status is read-only", () => {
      scheduled.trip("nested-sandbox-crash", "exit 71", { adapter: "codex", issue: "MOV-1" });
      const printed = [];
      const before = fs.readFileSync(statePath, "utf8");

      expect(runBreakerCommand(["status"], scheduled, ["nested-sandbox-crash"], { print: (line) => printed.push(line) })).toBe(0);
      expect(fs.readFileSync(statePath, "utf8")).toBe(before);
      expect(runBreakerCommand(["probe-now", "nested-sandbox-crash"], scheduled, ["nested-sandbox-crash"], { print: (line) => printed.push(line) })).toBe(0);
      expect(scheduled.status("nested-sandbox-crash")).toMatchObject({ due: true, failedProbes: 0 });
      expect(scheduled.load()["nested-sandbox-crash"].history).toHaveLength(1);
      expect(runBreakerCommand(["probe-now", "bogus"], scheduled, ["nested-sandbox-crash"], { printError: () => {} })).toBe(1);
    });
  });
});
