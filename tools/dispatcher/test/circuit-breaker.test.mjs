import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CircuitBreakerStore } from "../src/circuit-breaker.mjs";

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
});
