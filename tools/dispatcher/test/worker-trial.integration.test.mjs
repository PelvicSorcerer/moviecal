import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runOnce } from "../src/run-loop.mjs";
import { WorkerTrialStore, trialAttribution } from "../src/worker-trial.mjs";
import { UsageLimitStore } from "../src/usage-limit.mjs";
import { WorkerCooldownStore } from "../src/worker-cooldown.mjs";
import { resolveDispatchWorker, workerInvocation } from "../src/worker-routing.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { captureWorkerUsage, WorkerUsageStore, buildUsageExport, DISPATCHER_ORIGIN } from "../src/worker-usage.mjs";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(T0.getTime() + ms).toISOString();
const DELEGATE = { id: "actor-dispatcher", name: "moviecal-dispatcher" };
const STATE_IDS = { blocked: "b", agentWorking: "w", needsHumanDecision: "n", inReview: "r", readyForAgent: "q" };

function issue(n, labels = ["worker:any"]) {
  return {
    id: `id-${n}`,
    identifier: `MOV-${n}`,
    title: `Fixture ${n}`,
    description: "Do it.",
    url: `https://linear.app/moviecal/issue/MOV-${n}`,
    project: null,
    labels: ["execution:mac", ...labels],
    delegate: { ...DELEGATE, displayName: "moviecal-dispatcher" },
    blockedByIds: [],
  };
}

describe("worker:any -> Codex trial through the run loop (MOV-383)", () => {
  let dir;
  let clock;
  let trials;
  let created;
  let spawned;
  let usageStore;

  const fresh = () => new WorkerTrialStore({ configPath: path.join(dir, "trial.json"), ledgerPath: path.join(dir, "ledger.json") });

  function ctx(overrides = {}) {
    return {
      linearClient: { moveToState: vi.fn(async () => {}), addComment: vi.fn(async () => {}) },
      stateIds: STATE_IDS,
      worktreeManager: {
        activeCount: () => 0,
        isPathFree: () => true,
        isPathFreeForIssue: () => true,
        create(args) {
          created.push(args);
          return { path: `/fake/worktrees/${args.name}`, ...args };
        },
        prepareWorkerSpawn() {},
        setWorkerPid() {},
        markStatus() {},
      },
      dispatcherDelegate: DELEGATE,
      concurrencyLimit: 10,
      workerTimeoutMs: 2_700_000,
      iosRunnerOnline: true,
      secretPresent: () => true,
      worktreeRoot: "/fake/worktrees",
      ghRepo: "owner/repo",
      logRoot: path.join(dir, "logs"),
      spawnWorkerFn: vi.fn(async (args) => {
        spawned.push(args);
        return { exitCode: 0, logDir: args.logDir };
      }),
      findPrForBranchFn: vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true, headSha: "sha" })),
      auditWorkerResultFn: vi.fn(() => ({ ok: true, violations: [] })),
      repositoryContextFn: vi.fn(() => ({ branch: "b", headSha: "h", baseRef: "origin/master", baseSha: "s", clean: true, recentCommits: [], changedPaths: [] })),
      writeWorkerAuditFn: vi.fn(() => ({ path: "/x", sha256: "abc" })),
      publishWorkerResultFn: vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true, headSha: "sha" })),
      workerTrialStore: trials,
      now: () => clock,
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mov383-loop-"));
    clock = T0;
    trials = fresh();
    created = [];
    spawned = [];
    usageStore = new WorkerUsageStore(path.join(dir, "usage.json"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const activate = (max = 30, expiresInMs = DAY) => trials.activate({ trialId: "sol-vs-sonnet", expiresAt: iso(expiresInMs), maxAssignments: max, now: T0 });

  it("keeps the Claude baseline while disabled and dispatches with no trial attribution", async () => {
    const [result] = await runOnce([issue(1)], ctx());
    expect(result.outcome).not.toBe("config-error");
    expect(created[0]).toMatchObject({ worker: "claude", model: "default", trial: null });
    expect(spawned[0].trial).toBeNull();
    expect(trials.get("MOV-1")).toBeNull();
  });

  it("routes fresh worker:any to Codex/Sol at medium when active, preserving tier, and records attribution", async () => {
    activate();
    await runOnce([issue(1), issue(2, ["worker:any", "model:cheap"])], ctx());
    expect(created.map((c) => [c.id, c.worker, c.model])).toEqual([["MOV-1", "codex", "default"], ["MOV-2", "codex", "cheap"]]);
    const invocation = spawned[0].invocation;
    expect(invocation.args).toEqual(expect.arrayContaining(["gpt-6-sol", "model_reasoning_effort=medium"]));
    const attribution = created[0].trial;
    expect(attribution).toMatchObject({ trialId: "sol-vs-sonnet", requestedWorker: "any", resolvedWorker: "codex", assignedAt: T0.toISOString() });
    expect(attribution.routingReason).toContain("sol-vs-sonnet");
    expect(spawned[0].trial).toEqual(attribution);
    expect(trials.state(T0)).toMatchObject({ assigned: 2, remaining: 28 });
  });

  it("leaves explicit pins and unlabeled issues on their ordinary routes and consumes no slot", async () => {
    activate();
    await runOnce([issue(1, ["worker:claude"]), issue(2, ["worker:codex"]), issue(3, [])], ctx());
    expect(created.map((c) => [c.id, c.worker, c.trial])).toEqual([["MOV-1", "claude", null], ["MOV-2", "codex", null], ["MOV-3", "claude", null]]);
    expect(trials.state(T0).assigned).toBe(0);
  });

  it("keeps a strong-tier issue without an upgrade label blocked and consumes no slot", async () => {
    activate();
    const [result] = await runOnce([issue(1, ["worker:any", "model:strong"])], ctx());
    expect(result).toMatchObject({ outcome: "needs-human" });
    expect(created).toEqual([]);
    expect(trials.state(T0).assigned).toBe(0);
  });

  it("admits at most the cap within one batch and defers the rest to the baseline on the next poll", async () => {
    activate(2);
    const results = await runOnce([issue(1), issue(2), issue(3)], ctx());
    expect(created.map((c) => c.id)).toEqual(["MOV-1", "MOV-2"]);
    expect(results[2]).toMatchObject({ issue: "MOV-3", outcome: "deferred-worker-trial-ended" });
    expect(trials.state(T0)).toMatchObject({ status: "exhausted", assigned: 2 });
    // Next poll: exhausted trial, so MOV-3 resolves to the Claude baseline.
    await runOnce([issue(3)], ctx());
    expect(created[2]).toMatchObject({ id: "MOV-3", worker: "claude", trial: null });
  });

  it("restores the baseline after expiry without a restart, and after early stop", async () => {
    activate(10, 1000);
    const shared = ctx();
    await runOnce([issue(1)], shared);
    clock = new Date(T0.getTime() + 1000);
    await runOnce([issue(2)], shared); // same long-lived context, no restart
    expect(created.map((c) => [c.id, c.worker])).toEqual([["MOV-1", "codex"], ["MOV-2", "claude"]]);

    clock = T0;
    trials = fresh();
    trials.stop({ now: T0 });
    await runOnce([issue(3)], ctx({ workerTrialStore: trials }));
    expect(created[2]).toMatchObject({ id: "MOV-3", worker: "claude" });
  });

  it("expires between batch start and admission by deferring, never by silently switching worker", async () => {
    activate(10, 5000);
    let calls = 0;
    // First read (batch start) is before expiry; admission happens after it.
    const now = () => (calls++ < 2 ? T0 : new Date(T0.getTime() + 6000));
    const [result] = await runOnce([issue(1)], ctx({ now }));
    expect(result).toMatchObject({ outcome: "deferred-worker-trial-ended" });
    expect(created).toEqual([]);
  });

  it("does not double-count a retried, already-assigned issue and keeps its recorded worker after the trial ends", async () => {
    activate(1);
    await runOnce([issue(1)], ctx());
    expect(trials.state(T0)).toMatchObject({ status: "exhausted", assigned: 1 });
    // Restart + retry after exhaustion and after expiry: same worker, same attribution, no new slot.
    clock = new Date(T0.getTime() + 2 * DAY);
    trials = fresh();
    await runOnce([issue(1)], ctx({ workerTrialStore: trials }));
    expect(created[1]).toMatchObject({ id: "MOV-1", worker: "codex" });
    expect(created[1].trial).toMatchObject({ trialId: "sol-vs-sonnet", assignedAt: T0.toISOString() });
    expect(fresh().state(T0)).toMatchObject({ assigned: 1 });
  });

  it("falls back to Claude during a Codex cooldown without consuming a trial assignment", async () => {
    activate();
    const cooldowns = new WorkerCooldownStore(path.join(dir, "cooldowns.json"));
    cooldowns.record("codex", { resetAt: iso(3600_000), evidence: "usage limit", now: T0 });
    const [result] = await runOnce([issue(1)], ctx({ workerCooldownStore: cooldowns }));
    expect(result).toMatchObject({ outcome: "in-review" });
    expect(created[0]).toMatchObject({ worker: "claude", trial: null });
    expect(spawned[0].trial).toBeNull();
    expect(trials.state(T0).assigned).toBe(0); // Claude fallback is outside the Codex trial
  });

  it("rechecks a Codex limit in the same batch and keeps fallback out of the trial ledger", async () => {
    activate();
    const cooldowns = new WorkerCooldownStore(path.join(dir, "cooldowns.json"));
    const captured = [];
    const shared = ctx({ concurrencyLimit: 1, workerCooldownStore: cooldowns,
      usageLimitStore: new UsageLimitStore(path.join(dir, "limits.json")),
      captureWorkerUsageFn: (logDir, context) => { captured.push(context); return null; },
      spawnWorkerFn: vi.fn(async (args) => {
        spawned.push(args);
        fs.mkdirSync(args.logDir, { recursive: true });
        if (spawned.length === 1) {
          fs.writeFileSync(path.join(args.logDir, "stdout.log"), `usage limit reached; resets ${iso(3600_000).replace(".000Z", "Z")}`);
          return { exitCode: 1, logDir: args.logDir };
        }
        return { exitCode: 0, logDir: args.logDir };
      }),
    });
    const results = await runOnce([issue(1), issue(2)], shared);
    expect(results.map((r) => r.outcome)).toEqual(["usage-limit-deferred", "in-review"]);
    expect(created.map((c) => c.worker)).toEqual(["codex", "claude"]);
    expect(created[1].trial).toBeNull();
    expect(captured[1]).toMatchObject({ worker: "claude", trial: null });
    expect(fresh().state(T0).assigned).toBe(1);
    expect(fresh().get("MOV-2")).toBeNull();
    // After reset a fresh claim returns to requested Codex and consumes its own slot.
    clock = new Date(T0.getTime() + 3600_001);
    await runOnce([issue(3)], shared);
    expect(created[2]).toMatchObject({ worker: "codex", trial: { trialId: "sol-vs-sonnet" } });
    expect(fresh().state(clock).assigned).toBe(2);
  });

  it("refuses worker:any visibly on an invalid config while pinned issues still dispatch", async () => {
    fs.writeFileSync(path.join(dir, "trial.json"), JSON.stringify({ enabled: true, trialId: "t", activatedAt: iso(0), expiresAt: iso(30 * DAY), maxAssignments: 5 }));
    const results = await runOnce([issue(1), issue(2, ["worker:claude"])], ctx());
    expect(results[0]).toMatchObject({ issue: "MOV-1", outcome: "config-error", reason: expect.stringContaining("14 days") });
    expect(created.map((c) => c.id)).toEqual(["MOV-2"]);
  });

  it("keeps a usage-limit-bound worker for a resume regardless of the trial", async () => {
    activate();
    const usageLimitStore = {
      get: () => ({ worker: "claude" }),
      record: () => null,
      clear: () => {},
      deferral: () => ({ deferred: false, until: null, reason: null }),
      resumption: () => null,
      consumeResume: () => null,
    };
    await runOnce([issue(1)], ctx({ usageLimitStore }));
    expect(created[0]).toMatchObject({ worker: "claude", trial: null });
    expect(trials.state(T0).assigned).toBe(0);
  });

  it("previews the same route the run loop uses, without consuming a slot", () => {
    activate(1);
    const preview = (state) => resolveDispatchWorker(issue(1), { trial: { state, assignment: trials.get("MOV-1") } });
    expect(preview(trials.state(T0))).toMatchObject({ worker: "codex", trial: { pending: true } });
    expect(trials.state(T0).assigned).toBe(0);
  });

  describe("manifest and usage export attribution", () => {
    function fakeChild() {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\n");
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0));
      });
      return child;
    }

    it("reaches the manifest and the exported usage record, and stays null for baseline attempts", async () => {
      activate();
      const admission = trials.admit(issue(1), { tier: "default", now: T0 });
      const attribution = trialAttribution(admission.record);
      const invocation = workerInvocation("codex", "default");
      const logDir = path.join(dir, "attempt");
      await spawnWorker({ invocation, cwd: dir, brief: "fixture", logDir, trial: attribution, spawnImpl: fakeChild });
      const manifest = JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8"));
      expect(manifest.trial).toEqual(attribution);
      captureWorkerUsage(logDir, { issue: "MOV-1", attemptKind: "implementation", worker: "codex", tier: "default", modelId: "gpt-6-sol", reasoningEffort: "medium", trial: attribution, origin: DISPATCHER_ORIGIN, attemptId: "a1" }, { store: usageStore });

      const baselineDir = path.join(dir, "baseline");
      await spawnWorker({ invocation, cwd: dir, brief: "fixture", logDir: baselineDir, spawnImpl: fakeChild });
      expect(JSON.parse(fs.readFileSync(path.join(baselineDir, "manifest.json"), "utf8")).trial).toBeNull();
      captureWorkerUsage(baselineDir, { issue: "MOV-2", attemptKind: "implementation", worker: "claude", tier: "default", origin: DISPATCHER_ORIGIN, attemptId: "a2" }, { store: usageStore });

      const exported = buildUsageExport(usageStore.recent(), { issues: ["MOV-1", "MOV-2"] });
      const byIssue = Object.fromEntries(exported.runs.map((run) => [run.issue, run]));
      expect(byIssue["MOV-1"].trial).toEqual(attribution);
      expect(byIssue["MOV-1"]).toMatchObject({ worker: "codex", modelId: "gpt-6-sol", reasoningEffort: "medium" });
      expect(byIssue["MOV-2"].trial).toBeNull();
      expect(exported.byIssue.find((row) => row.issue === "MOV-1").trialIds).toEqual(["sol-vs-sonnet"]);
    });

    it("passes the same attribution to usage capture from the run loop, including for a retained retry", async () => {
      activate();
      const captured = [];
      const captureWorkerUsageFn = (logDir, context) => { captured.push(context); return null; };
      await runOnce([issue(1)], ctx({ captureWorkerUsageFn }));
      clock = new Date(T0.getTime() + 2 * DAY); // trial expired; retry keeps attribution
      await runOnce([issue(1)], ctx({ captureWorkerUsageFn }));
      expect(captured).toHaveLength(2);
      for (const context of captured) {
        expect(context).toMatchObject({ worker: "codex", tier: "default", trial: { trialId: "sol-vs-sonnet", resolvedWorker: "codex" } });
      }
    });
  });
});
