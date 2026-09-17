import { describe, it, expect, beforeEach } from "vitest";
import {
  activeAttempt,
  clearActiveAttempts,
  registerActiveAttempt,
  unregisterActiveAttempt,
  updateActiveAttempt,
} from "../src/active-attempt-registry.mjs";

beforeEach(() => {
  clearActiveAttempts();
});

describe("active-attempt-registry", () => {
  it("returns null for an issue with no registered attempt — the normal, common case", () => {
    expect(activeAttempt("uuid-1")).toBeNull();
  });

  it("registers and looks up an entry by issue id", () => {
    const controller = {};
    registerActiveAttempt("uuid-1", { identifier: "MOV-1", controller });
    expect(activeAttempt("uuid-1")).toEqual({ identifier: "MOV-1", controller });
  });

  it("supports more than one concurrent attempt, keyed independently", () => {
    registerActiveAttempt("uuid-1", { identifier: "MOV-1", controller: {} });
    registerActiveAttempt("uuid-2", { identifier: "MOV-2", controller: {} });
    expect(activeAttempt("uuid-1").identifier).toBe("MOV-1");
    expect(activeAttempt("uuid-2").identifier).toBe("MOV-2");
  });

  it("merges a patch onto an existing entry without dropping other fields", () => {
    registerActiveAttempt("uuid-1", { identifier: "MOV-1", controller: {} });
    updateActiveAttempt("uuid-1", { writeTurn: () => {} });
    const entry = activeAttempt("uuid-1");
    expect(entry.identifier).toBe("MOV-1");
    expect(typeof entry.writeTurn).toBe("function");
  });

  it("is a no-op to update an issue with no registered entry", () => {
    expect(() => updateActiveAttempt("uuid-missing", { writeTurn: () => {} })).not.toThrow();
    expect(activeAttempt("uuid-missing")).toBeNull();
  });

  it("removes an entry on unregister", () => {
    registerActiveAttempt("uuid-1", { identifier: "MOV-1", controller: {} });
    unregisterActiveAttempt("uuid-1");
    expect(activeAttempt("uuid-1")).toBeNull();
  });
});
