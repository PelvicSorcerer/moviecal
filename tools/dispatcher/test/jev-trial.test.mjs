import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JevArmStore,
  validateJevArmConfig,
  isEligibleForJevArm,
  describeJevState,
  jevAttribution,
  MAX_ARM_ASSIGNMENTS,
  MAX_SPEND_CEILING_USD,
  APPROVED_POLICY_HASHES,
  ELIGIBLE_LABEL,
} from "../src/jev-trial.mjs";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const APPROVED_HASH = "fixture-policy-hash-1";
const issue = (identifier, labels = [ELIGIBLE_LABEL]) => ({ identifier, labels });

describe("jev router arm admission (MOV-427)", () => {
  let dir;
  let store;
  const fresh = (opts = {}) => new JevArmStore({
    configPath: path.join(dir, "jev.json"),
    ledgerPath: path.join(dir, "jev-ledger.json"),
    approvedPolicyHashes: [APPROVED_HASH],
    ...opts,
  });
  const activateArgs = (overrides = {}) => ({
    trialId: "jev-1", armId: "jev-hosted", policyHash: APPROVED_HASH,
    expiresAt: iso(DAY), maxAssignments: 5, spendCeilingUsd: 10, now: NOW,
    ...overrides,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mov427-jev-"));
    store = fresh();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe("production default is fail-closed", () => {
    it("APPROVED_POLICY_HASHES ships empty, so no policy hash is approved yet", () => {
      expect(APPROVED_POLICY_HASHES).toEqual([]);
    });

    it("refuses activation against the real (empty) approved list", () => {
      const real = new JevArmStore({ configPath: path.join(dir, "real.json"), ledgerPath: path.join(dir, "real-ledger.json") });
      expect(() => real.activate(activateArgs())).toThrow(/approved policy hash list/);
    });
  });

  describe("state and activation", () => {
    it("is disabled by default", () => {
      expect(store.state(NOW)).toMatchObject({ status: "disabled", assigned: 0, spentUsd: 0 });
    });

    it("activates with an approved hash, a future expiry within 14 days, a cap of at most 12, and a positive spend ceiling", () => {
      const state = store.activate(activateArgs());
      expect(state).toMatchObject({
        status: "active", trialId: "jev-1", armId: "jev-hosted", policyHash: APPROVED_HASH,
        maxAssignments: 5, remaining: 5, spendCeilingUsd: 10, spentUsd: 0, spendRemainingUsd: 10,
      });
      expect(describeJevState(state)).toMatch(/^ACTIVE/);
    });

    it.each([
      ["an unapproved policy hash", { policyHash: "not-approved" }, /approved policy hash list/],
      ["a missing arm id", { armId: "not-a-real-arm" }, /armId must be one of/],
      ["a non-claude allowed worker", { allowedWorker: "codex" }, /allowedWorker must be 'claude'/],
      ["a past expiry", { expiresAt: iso(-1000) }, /future|after activatedAt/],
      ["an expiry beyond 14 days", { expiresAt: iso(14 * DAY + 1000) }, /14 days/],
      ["a non-UTC expiry", { expiresAt: "2026-10-02T12:00:00+02:00" }, /UTC/],
      ["a cap above 12", { maxAssignments: MAX_ARM_ASSIGNMENTS + 1 }, /1 to 12/],
      ["a zero cap", { maxAssignments: 0 }, /1 to 12/],
      ["a fractional cap", { maxAssignments: 2.5 }, /1 to 12/],
      ["a missing cap", { maxAssignments: undefined }, /1 to 12/],
      ["a zero spend ceiling", { spendCeilingUsd: 0 }, /spendCeilingUsd/],
      ["a negative spend ceiling", { spendCeilingUsd: -5 }, /spendCeilingUsd/],
      ["a spend ceiling above the max", { spendCeilingUsd: MAX_SPEND_CEILING_USD + 1 }, /spendCeilingUsd/],
    ])("refuses activation with %s", (_name, fields, message) => {
      expect(() => store.activate(activateArgs(fields))).toThrow(message);
      expect(store.state(NOW).status).toBe("disabled");
    });

    it("accepts exactly 14 days and the exact max cap/spend", () => {
      const state = store.activate(activateArgs({ expiresAt: iso(14 * DAY), maxAssignments: MAX_ARM_ASSIGNMENTS, spendCeilingUsd: MAX_SPEND_CEILING_USD }));
      expect(state.status).toBe("active");
    });

    it("refuses to activate over an already active arm", () => {
      store.activate(activateArgs());
      expect(() => store.activate(activateArgs({ trialId: "jev-2" }))).toThrow(/already active/);
    });

    it("expires at exactly expiresAt without a restart", () => {
      store.activate(activateArgs({ expiresAt: iso(1000) }));
      expect(store.state(new Date(NOW.getTime() + 999)).status).toBe("active");
      expect(store.state(new Date(NOW.getTime() + 1000)).status).toBe("expired");
      expect(describeJevState(store.state(new Date(NOW.getTime() + 1000)))).toMatch(/EXPIRED/);
    });

    it("reports an invalid hand-edited active config instead of admitting", () => {
      fs.writeFileSync(path.join(dir, "jev.json"), JSON.stringify({
        enabled: true, trialId: "jev-1", armId: "jev-hosted", policyHash: APPROVED_HASH,
        allowedWorker: "claude", activatedAt: iso(0), expiresAt: iso(30 * DAY), maxAssignments: 5, spendCeilingUsd: 10,
      }));
      const state = fresh().state(NOW);
      expect(state.status).toBe("invalid");
      expect(state.error).toMatch(/14 days/);
    });

    it("reports corrupt config and non-boolean enabled as invalid", () => {
      fs.writeFileSync(path.join(dir, "jev.json"), "{not json");
      expect(fresh().state(NOW).status).toBe("invalid");
      fs.writeFileSync(path.join(dir, "jev.json"), JSON.stringify({ enabled: "yes" }));
      expect(fresh().state(NOW)).toMatchObject({ status: "invalid", error: expect.stringMatching(/enabled/) });
    });
  });

  describe("eligibility", () => {
    it("requires the explicit opt-in label", () => {
      expect(isEligibleForJevArm(issue("MOV-1", []))).toMatchObject({ eligible: false, reason: expect.stringMatching(/router:jev/) });
      expect(isEligibleForJevArm(issue("MOV-1", [ELIGIBLE_LABEL]))).toMatchObject({ eligible: true, reason: null });
    });

    it.each([
      "human-only", "risk:high", "area:auth", "area:security", "area:database",
      "area:deployment", "area:migrations", "area:secrets", "security-sensitive",
    ])("excludes an issue labeled %s even with the opt-in label", (excluded) => {
      const result = isEligibleForJevArm(issue("MOV-1", [ELIGIBLE_LABEL, excluded]));
      expect(result).toMatchObject({ eligible: false, reason: expect.stringContaining(excluded) });
    });

    it("never reinterprets worker:* or model:* labels as eligibility signals", () => {
      expect(isEligibleForJevArm(issue("MOV-1", [ELIGIBLE_LABEL, "worker:codex", "model:strong"]))).toMatchObject({ eligible: true });
    });

    it("respects a custom eligible label", () => {
      expect(isEligibleForJevArm(issue("MOV-1", ["router:jev-oss"]), { eligibleLabel: "router:jev-oss" })).toMatchObject({ eligible: true });
    });
  });

  describe("durable assignment and spend accounting", () => {
    beforeEach(() => {
      store.activate(activateArgs({ maxAssignments: 2, spendCeilingUsd: 1 }));
    });

    it("admits an eligible issue, records attribution, and exhausts at the cap", () => {
      const a = store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      expect(a).toMatchObject({ admitted: true, existing: false });
      expect(a.record).toMatchObject({ trialId: "jev-1", armId: "jev-hosted", policyHash: APPROVED_HASH, issue: "MOV-1", worker: "claude", tier: "default", assignedAt: NOW.toISOString() });
      expect(a.record.reason).toContain("jev-1");
      expect(store.admit(issue("MOV-2"), { tier: "cheap", now: NOW }).admitted).toBe(true);
      const third = store.admit(issue("MOV-3"), { tier: "default", now: NOW });
      expect(third).toMatchObject({ admitted: false, record: null, reason: "jev arm is exhausted" });
      expect(third.state.status).toBe("exhausted");
      expect(store.get("MOV-3")).toBeNull();
    });

    it("refuses an ineligible issue without consuming a slot", () => {
      const result = store.admit(issue("MOV-1", []), { tier: "default", now: NOW });
      expect(result).toMatchObject({ admitted: false, record: null });
      expect(result.reason).toMatch(/router:jev/);
      expect(store.state(NOW).assigned).toBe(0);
      expect(store.get("MOV-1")).toBeNull();
    });

    it("does not double-count a duplicate or restarted admission, even if the issue's labels later change", () => {
      store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      const relabeled = issue("MOV-1", []); // now missing the opt-in label
      const again = fresh().admit(relabeled, { tier: "default", now: new Date(NOW.getTime() + 5000) });
      expect(again).toMatchObject({ admitted: true, existing: true });
      expect(again.record.assignedAt).toBe(NOW.toISOString());
      expect(fresh().state(NOW)).toMatchObject({ assigned: 1, remaining: 1 });
    });

    it("re-evaluates expiry before every admission, and keeps an existing assignment after expiry", () => {
      store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      const later = new Date(NOW.getTime() + 2 * DAY);
      expect(store.admit(issue("MOV-2"), { tier: "default", now: later })).toMatchObject({ admitted: false });
      expect(store.admit(issue("MOV-1"), { tier: "default", now: later })).toMatchObject({ admitted: true, existing: true });
    });

    it("counts only the current arm's assignments toward its cap", () => {
      store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      store.stop({ now: NOW });
      store.activate(activateArgs({ trialId: "jev-2", maxAssignments: 2, spendCeilingUsd: 1 }));
      expect(store.state(NOW)).toMatchObject({ status: "active", assigned: 0 });
    });

    it("stops admitting once recorded spend reaches the ceiling", () => {
      store.recordSpend({ requestId: "req-1", issue: "MOV-1", amountUsd: 1 }, NOW);
      const result = store.admit(issue("MOV-2"), { tier: "default", now: NOW });
      expect(result).toMatchObject({ admitted: false, reason: "jev arm is spend-exhausted" });
      expect(store.state(NOW)).toMatchObject({ status: "spend-exhausted", spentUsd: 1, spendRemainingUsd: 0 });
    });

    it("does not double-count a retried spend report for the same request ID", () => {
      store.recordSpend({ requestId: "req-1", amountUsd: 0.4 }, NOW);
      store.recordSpend({ requestId: "req-1", amountUsd: 0.4 }, NOW);
      expect(fresh().state(NOW).spentUsd).toBe(0.4);
    });

    it("sums distinct spend records and survives a restart", () => {
      store.recordSpend({ requestId: "req-1", amountUsd: 0.3 }, NOW);
      store.recordSpend({ requestId: "req-2", amountUsd: 0.25 }, NOW);
      expect(fresh().state(NOW)).toMatchObject({ spentUsd: 0.55, spendRemainingUsd: 0.45 });
    });

    it("early stop disables new admissions, keeps every record, and is idempotent", () => {
      store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      expect(store.stop({ now: NOW })).toMatchObject({ status: "disabled", assigned: 1, stoppedAt: NOW.toISOString() });
      expect(store.stop({ now: NOW }).status).toBe("disabled");
      expect(store.admit(issue("MOV-2"), { tier: "default", now: NOW }).admitted).toBe(false);
      expect(store.get("MOV-1")).toMatchObject({ worker: "claude" });
    });
  });

  describe("attribution and describeJevState", () => {
    it("returns null attribution for a null record", () => {
      expect(jevAttribution(null)).toBeNull();
    });

    it("carries only bounded identifiers", () => {
      const record = { trialId: "jev-1", armId: "jev-hosted", policyHash: APPROVED_HASH, worker: "claude", reason: "why", assignedAt: iso(0) };
      expect(jevAttribution(record)).toEqual({
        trialId: "jev-1", armId: "jev-hosted", policyHash: APPROVED_HASH, worker: "claude", routingReason: "why", assignedAt: iso(0),
      });
    });

    it("describes every status", () => {
      expect(describeJevState({ status: "disabled", trialId: null, maxAssignments: null })).toMatch(/disabled/);
      expect(describeJevState({ status: "exhausted", trialId: "jev-1", armId: "jev-hosted", maxAssignments: 1, assigned: 1, spentUsd: 0, spendCeilingUsd: 1 })).toMatch(/EXHAUSTED/);
      expect(describeJevState({ status: "spend-exhausted", trialId: "jev-1", armId: "jev-hosted", maxAssignments: 1, assigned: 0, spentUsd: 1, spendCeilingUsd: 1 })).toMatch(/SPEND CEILING REACHED/);
      expect(describeJevState({ status: "invalid", error: "bad", trialId: null, maxAssignments: null })).toMatch(/INVALID CONFIG/);
    });
  });

  describe("validateJevArmConfig", () => {
    it("accepts an explicit approvedPolicyHashes override", () => {
      const config = { enabled: true, trialId: "t", armId: "jev-hosted", policyHash: "h", allowedWorker: "claude", activatedAt: iso(0), expiresAt: iso(DAY), maxAssignments: 1, spendCeilingUsd: 1 };
      expect(validateJevArmConfig(config, { approvedPolicyHashes: ["h"] })).toBeNull();
      expect(validateJevArmConfig(config)).toMatch(/approved policy hash list/);
    });

    it("rejects a non-object config", () => {
      expect(validateJevArmConfig(null)).toMatch(/JSON object/);
      expect(validateJevArmConfig([])).toMatch(/JSON object/);
    });
  });
});
