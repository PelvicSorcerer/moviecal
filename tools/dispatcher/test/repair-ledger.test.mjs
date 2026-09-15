import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepairLedger, repairJobKey } from "../src/repair-ledger.mjs";

const NOW = new Date("2026-09-14T12:00:00.000Z");

describe("repairJobKey", () => {
  it("is stable across fingerprint ordering, so a reordered observation is the same job", () => {
    const a = repairJobKey({ prNumber: 7, headSha: "abc", kind: "code-repair", fingerprints: ["f1", "f2"] });
    const b = repairJobKey({ prNumber: 7, headSha: "abc", kind: "code-repair", fingerprints: ["f2", "f1"] });
    expect(a).toBe(b);
  });

  it("separates a changed failure, a new head, and a different action", () => {
    const base = { prNumber: 7, headSha: "abc", kind: "code-repair", fingerprints: ["f1"] };
    expect(repairJobKey({ ...base, fingerprints: ["f9"] })).not.toBe(repairJobKey(base));
    expect(repairJobKey({ ...base, headSha: "def" })).not.toBe(repairJobKey(base));
    expect(repairJobKey({ ...base, kind: "infrastructure-rerun" })).not.toBe(repairJobKey(base));
  });

  it("refuses to build a key without the identity it exists to capture", () => {
    expect(() => repairJobKey({ headSha: "abc", kind: "code-repair" })).toThrow(/requires prNumber/);
    expect(() => repairJobKey({ prNumber: 7, kind: "code-repair" })).toThrow(/requires prNumber/);
    expect(() => repairJobKey({ prNumber: 7, headSha: "abc" })).toThrow(/requires prNumber/);
  });
});

describe("RepairLedger", () => {
  let tmpRoot;
  let statePath;
  let ledger;

  const reserve = (overrides = {}) => {
    const args = { prNumber: 7, headSha: "abc", kind: "code-repair", fingerprints: ["f1"], ...overrides };
    const key = repairJobKey(args);
    ledger.reserve("MOV-1", { ...args, key, now: NOW });
    return key;
  };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-repair-ledger-test-"));
    statePath = path.join(tmpRoot, "config", "repair-ledger.json");
    ledger = new RepairLedger(statePath);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("starts every issue at an unspent budget", () => {
    expect(ledger.previousAttempts("MOV-1", 7)).toEqual({ codeRepair: 0, infrastructureRerun: 0, total: 0 });
    expect(ledger.attempts("MOV-1")).toEqual([]);
  });

  it("reserving is idempotent, so a repeated observation is one job not two", () => {
    const key = reserve();
    reserve();
    expect(ledger.attempts("MOV-1")).toHaveLength(1);
    expect(ledger.has("MOV-1", key)).toBe(true);
    expect(ledger.previousAttempts("MOV-1", 7).codeRepair).toBe(1);
  });

  // The budget is per PR across head SHAs: a published repair *creates* a new
  // head SHA, so counting per SHA would reset the budget on every attempt it
  // was supposed to be bounding.
  it("counts attempts across head SHAs within one PR", () => {
    reserve({ headSha: "sha-1" });
    reserve({ headSha: "sha-2" });
    expect(ledger.previousAttempts("MOV-1", 7)).toMatchObject({ codeRepair: 2, total: 2 });
  });

  it("scopes the budget to the PR, so a second PR starts clean", () => {
    reserve({ prNumber: 7 });
    expect(ledger.previousAttempts("MOV-1", 8)).toEqual({ codeRepair: 0, infrastructureRerun: 0, total: 0 });
  });

  it("does not let an escalation spend repair budget", () => {
    ledger.recordEscalation("MOV-1", {
      key: repairJobKey({ prNumber: 7, headSha: "abc", kind: "escalation", fingerprints: [] }),
      prNumber: 7,
      headSha: "abc",
      reason: "sensitive failure",
      now: NOW,
    });
    expect(ledger.previousAttempts("MOV-1", 7).total).toBe(0);
    expect(ledger.attempts("MOV-1")[0]).toMatchObject({ kind: "escalation", outcome: "escalated" });
  });

  // Reserve-before-act is what makes a crashed repair recoverable as a
  // refusal rather than as an unbounded retry.
  it("leaves a reserved-but-uncompleted attempt visible as unfinished", () => {
    const key = reserve();
    expect(ledger.unfinished("MOV-1", 7)).toMatchObject({ key, outcome: "in-progress" });

    ledger.complete("MOV-1", key, { outcome: "published", detail: "https://pr", headSha: "new-sha", now: NOW });
    expect(ledger.unfinished("MOV-1", 7)).toBeNull();
    expect(ledger.find("MOV-1", key)).toMatchObject({ outcome: "published", resultHeadSha: "new-sha" });
  });

  it("survives a restart", () => {
    const key = reserve();
    expect(new RepairLedger(statePath).has("MOV-1", key)).toBe(true);
  });

  it("rejects an unknown kind or outcome rather than silently recording it", () => {
    expect(() => ledger.reserve("MOV-1", { key: "k", kind: "rewrite-history" })).toThrow(/unknown repair kind/);
    expect(() => ledger.reserve("MOV-1", { kind: "code-repair" })).toThrow(/requires a job key/);
    const key = reserve();
    expect(() => ledger.complete("MOV-1", key, { outcome: "probably-fine" })).toThrow(/unknown repair outcome/);
  });

  it("completing an unknown key is a no-op rather than an error", () => {
    expect(ledger.complete("MOV-1", "never-reserved", { outcome: "published", now: NOW })).toBeNull();
  });

  it("forgets an issue on request", () => {
    reserve();
    ledger.forget("MOV-1");
    expect(ledger.attempts("MOV-1")).toEqual([]);
    expect(() => ledger.forget("MOV-1")).not.toThrow();
  });
});
