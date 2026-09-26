import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerTrialStore, validateTrialConfig, describeTrialState, MAX_TRIAL_ASSIGNMENTS } from "../src/worker-trial.mjs";
import { resolveDispatchWorker, resolveRouting, workerInvocation } from "../src/worker-routing.mjs";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const issue = (identifier, labels = ["worker:any"]) => ({ identifier, labels });

describe("worker trial (MOV-383)", () => {
  let dir;
  let store;
  const fresh = () => new WorkerTrialStore({ configPath: path.join(dir, "trial.json"), ledgerPath: path.join(dir, "ledger.json") });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mov383-trial-"));
    store = fresh();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe("state and activation", () => {
    it("is disabled by default", () => {
      expect(store.state(NOW)).toMatchObject({ status: "disabled", assigned: 0 });
    });

    it("activates with a future expiry within 14 days and a cap of at most 30", () => {
      const state = store.activate({ trialId: "sol-vs-sonnet", expiresAt: iso(DAY), maxAssignments: 30, now: NOW });
      expect(state).toMatchObject({ status: "active", trialId: "sol-vs-sonnet", maxAssignments: 30, remaining: 30, activatedAt: NOW.toISOString() });
      expect(describeTrialState(state)).toMatch(/^ACTIVE/);
    });

    it.each([
      ["a past expiry", { expiresAt: iso(-1000), maxAssignments: 5 }, /future|after activatedAt/],
      ["an expiry equal to now", { expiresAt: iso(0), maxAssignments: 5 }, /future|after activatedAt/],
      ["an expiry beyond 14 days", { expiresAt: iso(14 * DAY + 1000), maxAssignments: 5 }, /14 days/],
      ["a non-UTC expiry", { expiresAt: "2026-10-02T12:00:00+02:00", maxAssignments: 5 }, /UTC/],
      ["a cap above 30", { expiresAt: iso(DAY), maxAssignments: MAX_TRIAL_ASSIGNMENTS + 1 }, /1 to 30/],
      ["a zero cap", { expiresAt: iso(DAY), maxAssignments: 0 }, /1 to 30/],
      ["a fractional cap", { expiresAt: iso(DAY), maxAssignments: 2.5 }, /1 to 30/],
      ["a missing cap", { expiresAt: iso(DAY) }, /1 to 30/],
    ])("refuses activation with %s", (_name, fields, message) => {
      expect(() => store.activate({ trialId: "t1", now: NOW, ...fields })).toThrow(message);
      expect(store.state(NOW).status).toBe("disabled");
    });

    it("accepts exactly 14 days and refuses a bad trial ID", () => {
      expect(store.activate({ trialId: "t1", expiresAt: iso(14 * DAY), maxAssignments: 1, now: NOW }).status).toBe("active");
      const other = new WorkerTrialStore({ configPath: path.join(dir, "b.json"), ledgerPath: path.join(dir, "bl.json") });
      expect(() => other.activate({ trialId: "bad id!", expiresAt: iso(DAY), maxAssignments: 1, now: NOW })).toThrow(/trialId/);
    });

    it("refuses to activate over an already active trial", () => {
      store.activate({ trialId: "t1", expiresAt: iso(DAY), maxAssignments: 3, now: NOW });
      expect(() => store.activate({ trialId: "t2", expiresAt: iso(DAY), maxAssignments: 3, now: NOW })).toThrow(/already active/);
    });

    it("expires at exactly expiresAt without a restart", () => {
      store.activate({ trialId: "t1", expiresAt: iso(1000), maxAssignments: 3, now: NOW });
      expect(store.state(new Date(NOW.getTime() + 999)).status).toBe("active");
      expect(store.state(new Date(NOW.getTime() + 1000)).status).toBe("expired");
      expect(describeTrialState(store.state(new Date(NOW.getTime() + 1000)))).toMatch(/EXPIRED/);
    });

    it("reports an invalid hand-edited active config instead of dispatching", () => {
      fs.writeFileSync(path.join(dir, "trial.json"), JSON.stringify({ enabled: true, trialId: "t1", activatedAt: iso(0), expiresAt: iso(30 * DAY), maxAssignments: 99 }));
      const state = store.state(NOW);
      expect(state.status).toBe("invalid");
      expect(state.error).toMatch(/14 days/);
      expect(validateTrialConfig({ trialId: "t1", activatedAt: iso(0), expiresAt: iso(DAY), maxAssignments: 31 })).toMatch(/1 to 30/);
    });

    it("reports corrupt config and non-boolean enabled as invalid", () => {
      fs.writeFileSync(path.join(dir, "trial.json"), "{not json");
      expect(store.state(NOW).status).toBe("invalid");
      fs.writeFileSync(path.join(dir, "trial.json"), JSON.stringify({ enabled: "yes" }));
      expect(fresh().state(NOW)).toMatchObject({ status: "invalid", error: expect.stringMatching(/enabled/) });
    });
  });

  describe("durable assignment accounting", () => {
    beforeEach(() => {
      store.activate({ trialId: "t1", expiresAt: iso(DAY), maxAssignments: 2, now: NOW });
    });

    it("admits distinct issues, records attribution, and exhausts at the cap", () => {
      const a = store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      expect(a).toMatchObject({ admitted: true, existing: false });
      expect(a.record).toMatchObject({ trialId: "t1", issue: "MOV-1", requestedWorker: "any", worker: "codex", tier: "default", assignedAt: NOW.toISOString() });
      expect(a.record.reason).toContain("t1");
      expect(store.admit(issue("MOV-2"), { tier: "cheap", now: NOW }).admitted).toBe(true);
      const third = store.admit(issue("MOV-3"), { tier: "default", now: NOW });
      expect(third).toMatchObject({ admitted: false, record: null });
      expect(third.state.status).toBe("exhausted");
      expect(store.get("MOV-3")).toBeNull();
    });

    it("does not double-count a duplicate or restarted admission", () => {
      store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      const again = fresh().admit(issue("MOV-1"), { tier: "default", now: new Date(NOW.getTime() + 5000) });
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

    it("early stop disables new admissions, keeps every record, and is idempotent", () => {
      store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      expect(store.stop({ now: NOW })).toMatchObject({ status: "disabled", assigned: 1, stoppedAt: NOW.toISOString() });
      expect(store.stop({ now: NOW }).status).toBe("disabled");
      expect(store.admit(issue("MOV-2"), { tier: "default", now: NOW }).admitted).toBe(false);
      expect(store.get("MOV-1")).toMatchObject({ worker: "codex" });
    });

    it("counts only the current trial's assignments toward its cap", () => {
      store.admit(issue("MOV-1"), { tier: "default", now: NOW });
      store.stop({ now: NOW });
      store.activate({ trialId: "t2", expiresAt: iso(DAY), maxAssignments: 2, now: NOW });
      expect(store.state(NOW)).toMatchObject({ status: "active", assigned: 0 });
    });
  });

  describe("resolveDispatchWorker with a trial", () => {
    const active = { status: "active", trialId: "t1" };
    const trial = (state, assignment = null) => ({ state, assignment });

    it("matches the prior policy with no trial, or a disabled/expired/exhausted one", () => {
      for (const state of [null, { status: "disabled" }, { status: "expired", trialId: "t1" }, { status: "exhausted", trialId: "t1" }]) {
        const result = resolveDispatchWorker(issue("MOV-1"), { trial: state && trial(state) });
        expect(result).toMatchObject({ worker: "claude", isAny: true, bound: false, trial: null, configError: null, ok: true });
      }
    });

    it.each(["cheap", "default", "strong"])("routes a fresh worker:any %s issue to codex and keeps its tier", (tier) => {
      const labels = ["worker:any", `model:${tier}`, ...(tier === "strong" ? ["upgrade:architecture"] : [])];
      const result = resolveDispatchWorker(issue("MOV-1", labels), { trial: trial(active) });
      expect(result).toMatchObject({ worker: "codex", model: tier, ok: true, trial: { trialId: "t1", pending: true } });
      expect(result.trial.routingReason).toContain("t1");
    });

    it("selects the pinned Sol/medium invocation for the default tier", () => {
      const routed = resolveDispatchWorker(issue("MOV-1", ["worker:any", "model:default"]), { trial: trial(active) });
      const invocation = workerInvocation(routed.worker, routed.model);
      expect(invocation.args).toContain("gpt-6-sol");
      expect(invocation.args).toContain("model_reasoning_effort=medium");
    });

    it("leaves explicit pins and unlabeled issues on their ordinary routes", () => {
      expect(resolveDispatchWorker(issue("MOV-1", ["worker:claude"]), { trial: trial(active) })).toMatchObject({ worker: "claude", trial: null });
      expect(resolveDispatchWorker(issue("MOV-1", ["worker:codex"]), { trial: trial(active) })).toMatchObject({ worker: "codex", trial: null });
      expect(resolveDispatchWorker(issue("MOV-1", []), { trial: trial(active) })).toMatchObject({ worker: "claude", trial: null });
    });

    it("does not change the strong-tier upgrade validation", () => {
      const labels = ["worker:any", "model:strong"];
      const result = resolveDispatchWorker(issue("MOV-1", labels), { trial: trial(active) });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(resolveRouting(issue("MOV-1", labels)).reason);
      expect(result.trial).toBeNull();
    });

    it("keeps a recorded assignment after the trial ends, even when disabled", () => {
      const assignment = { trialId: "t1", worker: "codex", reason: "r", assignedAt: iso(0) };
      const result = resolveDispatchWorker(issue("MOV-1"), { trial: trial({ status: "disabled" }, assignment) });
      expect(result).toMatchObject({ worker: "codex", bound: true, trial: { trialId: "t1", pending: false, assignedAt: iso(0) } });
    });

    it("lets an explicit operator pin override a recorded assignment", () => {
      const assignment = { trialId: "t1", worker: "codex", reason: "r", assignedAt: iso(0) };
      expect(resolveDispatchWorker(issue("MOV-1", ["worker:claude"]), { trial: trial(active, assignment) })).toMatchObject({ worker: "claude", trial: null });
    });

    it("prefers the usage-limit binding and never reselects a worker", () => {
      const result = resolveDispatchWorker(issue("MOV-1"), { boundWorker: "claude", trial: trial(active) });
      expect(result).toMatchObject({ worker: "claude", bound: true });
    });

    it("surfaces an invalid config as a config error with no worker, only for worker:any", () => {
      const invalid = { status: "invalid", error: "maxAssignments must be an integer from 1 to 30" };
      const any = resolveDispatchWorker(issue("MOV-1"), { trial: trial(invalid) });
      expect(any).toMatchObject({ ok: false, worker: null, configError: invalid.error });
      expect(any.reason).toContain("invalid");
      expect(resolveDispatchWorker(issue("MOV-1", ["worker:claude"]), { trial: trial(invalid) })).toMatchObject({ ok: true, worker: "claude", configError: null });
    });
  });
});
