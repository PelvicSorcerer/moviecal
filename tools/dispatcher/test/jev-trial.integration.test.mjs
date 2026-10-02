import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runOnce } from "../src/run-loop.mjs";
import { JevArmStore, jevAttribution, ELIGIBLE_LABEL } from "../src/jev-trial.mjs";
import { JevCohortStore, policyDigest, resolveCohortTransport } from "../src/jev-cohort.mjs";
import { resolveRouting, workerInvocation } from "../src/worker-routing.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { captureWorkerUsage, WorkerUsageStore, buildUsageExport, DISPATCHER_ORIGIN } from "../src/worker-usage.mjs";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(T0.getTime() + ms).toISOString();
const DELEGATE = { id: "actor-dispatcher", name: "moviecal-dispatcher" };
const STATE_IDS = { blocked: "b", agentWorking: "w", needsHumanDecision: "n", inReview: "r", readyForAgent: "q" };
const APPROVED_HASH = "fixture-policy-hash-1";

function issue(n, labels = [ELIGIBLE_LABEL]) {
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

describe("bounded Jev router arm admission through the run loop (MOV-427)", () => {
  let dir;
  let clock;
  let jevStore;
  let created;
  let spawned;
  let usageStore;

  const fresh = () => new JevArmStore({
    configPath: path.join(dir, "jev.json"),
    ledgerPath: path.join(dir, "jev-ledger.json"),
    approvedPolicyHashes: [APPROVED_HASH],
  });

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
      jevTrialStore: jevStore,
      now: () => clock,
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mov427-loop-"));
    clock = T0;
    jevStore = fresh();
    created = [];
    spawned = [];
    usageStore = new WorkerUsageStore(path.join(dir, "usage.json"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const activate = (overrides = {}) => jevStore.activate({
    trialId: "jev-1", armId: "jev-hosted", policyHash: APPROVED_HASH,
    expiresAt: iso(DAY), maxAssignments: 12, spendCeilingUsd: 75, now: T0,
    ...overrides,
  });

  it("dispatches ordinary worker:*/model:* routing unchanged while disabled, with no jev attribution", async () => {
    const [result] = await runOnce([issue(1)], ctx());
    expect(result.outcome).not.toBe("config-error");
    expect(created[0]).toMatchObject({ worker: "claude", model: "default", jev: null });
    expect(spawned[0].jev).toBeNull();
    expect(jevStore.get("MOV-1")).toBeNull();
  });

  it("wires preselected routed and fixed API controls through run-loop with no substitution", async () => {
    const home = path.join(dir, "home"), storeDir = path.join(home, ".config", "moviecal");
    fs.mkdirSync(storeDir, { recursive: true });
    const policy = { trialId: "paired-1", route: "codex-openrouter-responses",
      activatedAt: T0.toISOString(), expiresAt: iso(DAY),
      pairs: [{ routed: "MOV-1", control: "MOV-2" }],
      routed: { model: "typesafe/jev-router", worker: "codex", tier: "default" },
      control: { model: "openai/fixture", worker: "codex", provider: "OpenAI", providerSlug: "openai", effort: "medium", tier: "default" },
      keyId: "fixture_key", workspaceId: "fixture_workspace", keyLimitUsd: 69,
      allInCeilingUsd: 75, priorOutlayUsd: 5, baselineKeyUsageUsd: 1, purchaseFeesUsd: 0,
      modelAliases: { "openai/fixture": "openai/fixture" } };
    const configPath = path.join(storeDir, "jev-cohort.json"), approvalPath = path.join(storeDir, "jev-cohort-approval.json");
    fs.writeFileSync(configPath, JSON.stringify({ enabled: false, policy }), { mode: 0o600 });
    fs.writeFileSync(approvalPath, JSON.stringify({ issue: "MOV-431", owner: "Adam Moore", ownerApproved: true,
      securityReviewPassed: true, accountPolicyReviewed: true, effectiveEligibilityUnrestricted: true,
      promptLoggingOff: true, zdrOff: true, dataCollectionUnrestricted: true,
      priorOutlayBasisReviewed: true, keyLimitUsd: 69, allInCeilingUsd: 75,
      keyId: policy.keyId, workspaceId: policy.workspaceId, policySha256: policyDigest(policy),
      reviewedAt: T0.toISOString(), expiresAt: policy.expiresAt,
      availableCreditUsd: 69, keyRemainingUsd: 68 }), { mode: 0o600 });
    const cohort = new JevCohortStore({ home, configPath, approvalPath, ledgerPath: path.join(storeDir, "jev-cohort-ledger.json") });
    cohort.activate(T0);
    const context = ctx({ jevCohortStore: cohort,
      resolveCohortTransportFn: (record, options = {}) => resolveCohortTransport(cohort, record, { ...options, home }),
      validateJevTransportFn: vi.fn() });
    await runOnce([issue(1, ["router:jev", "worker:codex"]), issue(2, ["worker:codex"])], context);
    expect(created.map((item) => item.jev?.side)).toEqual(["routed", "control"]);
    expect(spawned.map((item) => item.providerTransport?.policy.model)).toEqual(["typesafe/jev-router", "openai/fixture"]);
    expect(cohort.state(T0)).toMatchObject({ routed: 1, control: 1 });
    cohort.stop("operator-stop", T0);
    const result = await runOnce([issue(2, ["worker:codex"])], context);
    expect(result[0].outcome).toBe("needs-human");
    expect(spawned).toHaveLength(2);
  });

  it("defers a Codex arm before admission when the reviewed transport is absent", async () => {
    activate({ allowedWorker: "codex" });
    const context = ctx();
    const [result] = await runOnce([issue(90, [ELIGIBLE_LABEL, "worker:codex"])], context);
    expect(result.outcome).toBe("needs-human");
    expect(created).toEqual([]); expect(spawned).toEqual([]);
    expect(jevStore.state(T0).assigned).toBe(0);
    expect(context.linearClient.addComment).toHaveBeenCalled();
  });

  it("passes the reviewed Codex transport, pins retries and records invoices once", async () => {
    activate({ allowedWorker: "codex" });
    const transport = { enabled: true, policy: { hash: APPROVED_HASH } };
    const context = ctx({ resolveJevTransportFn: () => transport, validateJevTransportFn: vi.fn(),
      captureWorkerUsageFn: () => ({ routedRequests: [{ invoiceId: "gen-fixture", billedUsd: 0.02 }] }) });
    await runOnce([issue(91, [ELIGIBLE_LABEL, "worker:codex"])], context);
    expect(created[0].jev.worker).toBe("codex");
    expect(spawned[0].providerTransport).toBe(transport);
    expect(spawned[0].issueIdentifier).toBe("MOV-91");
    jevStore.stop({ now: clock });
    await runOnce([issue(91, ["worker:codex"])], context);
    expect(spawned[1].jev).toEqual(spawned[0].jev);
    expect(jevStore.state(clock)).toMatchObject({ assigned: 1, spentUsd: 0.02 });
    const [mismatch] = await runOnce([issue(91, ["worker:claude"])], context);
    expect(mismatch.outcome).toBe("needs-human");
    expect(spawned).toHaveLength(2);
  });

  it.each(["invalid", "mismatch"])("refuses %s Codex transport without consuming admission", async (failure) => {
    activate({ allowedWorker: "codex" });
    const [result] = await runOnce([issue(92, [ELIGIBLE_LABEL, "worker:codex"])], ctx({
      resolveJevTransportFn: () => ({ policy: { hash: "wrong-hash" } }),
      validateJevTransportFn: () => { if (failure === "invalid") throw new Error("fixture invalid"); },
    }));
    expect(result.outcome).toBe("needs-human");
    expect(jevStore.state(clock).assigned).toBe(0); expect(spawned).toEqual([]);
  });

  it("admits an eligible, opted-in issue when active, without changing its resolved worker/model", async () => {
    activate();
    await runOnce([issue(1), issue(2, [ELIGIBLE_LABEL, "model:cheap"])], ctx());
    // Ordinary routing is completely untouched: both still resolve to claude.
    expect(created.map((c) => [c.id, c.worker, c.model])).toEqual([["MOV-1", "claude", "default"], ["MOV-2", "claude", "cheap"]]);
    const attribution = created[0].jev;
    expect(attribution).toMatchObject({ trialId: "jev-1", armId: "jev-hosted", policyHash: APPROVED_HASH, worker: "claude", assignedAt: T0.toISOString() });
    expect(attribution.routingReason).toContain("jev-1");
    expect(spawned[0].jev).toEqual(attribution);
    expect(jevStore.state(T0)).toMatchObject({ assigned: 2, remaining: 10 });
  });

  it("does not admit an issue missing the opt-in label, and still dispatches it normally", async () => {
    activate();
    const [result] = await runOnce([issue(1, [])], ctx());
    expect(result.outcome).not.toBe("config-error");
    expect(created[0]).toMatchObject({ id: "MOV-1", worker: "claude", jev: null });
    expect(jevStore.state(T0).assigned).toBe(0);
  });

  it("excludes a high-risk/auth/human-only issue even with the opt-in label, and still dispatches it", async () => {
    activate();
    await runOnce([issue(1, [ELIGIBLE_LABEL, "risk:high"])], ctx());
    expect(created[0]).toMatchObject({ id: "MOV-1", jev: null });
    expect(jevStore.state(T0).assigned).toBe(0);
  });

  it("admits up to the 12-assignment cap within one batch, then leaves the rest unattributed but still dispatched", async () => {
    activate({ maxAssignments: 2 });
    const issues = [issue(1), issue(2), issue(3)];
    const results = await runOnce(issues, ctx());
    // Non-blocking: every issue dispatches regardless of admission outcome.
    expect(results.every((r) => r.outcome !== "config-error")).toBe(true);
    expect(created.map((c) => c.id)).toEqual(["MOV-1", "MOV-2", "MOV-3"]);
    expect(created.map((c) => Boolean(c.jev))).toEqual([true, true, false]);
    expect(jevStore.state(T0)).toMatchObject({ status: "exhausted", assigned: 2 });
  });

  it("stops admitting once the spend ceiling is reached, without blocking dispatch", async () => {
    activate({ spendCeilingUsd: 1 });
    jevStore.recordSpend({ requestId: "req-1", amountUsd: 1 }, T0);
    const [result] = await runOnce([issue(1)], ctx());
    expect(result.outcome).not.toBe("config-error");
    expect(created[0]).toMatchObject({ id: "MOV-1", jev: null });
    expect(jevStore.state(T0).status).toBe("spend-exhausted");
  });

  it("restores fixed routing (no new admissions) after expiry, without a daemon restart", async () => {
    activate({ expiresAt: iso(1000) });
    const shared = ctx();
    await runOnce([issue(1)], shared);
    clock = new Date(T0.getTime() + 1000);
    await runOnce([issue(2)], shared); // same long-lived context, no restart
    expect(created.map((c) => [c.id, Boolean(c.jev)])).toEqual([["MOV-1", true], ["MOV-2", false]]);
  });

  it("restores fixed routing after early stop, and stop is idempotent", async () => {
    activate();
    jevStore.stop({ now: T0 });
    expect(jevStore.stop({ now: T0 }).status).toBe("disabled");
    await runOnce([issue(1)], ctx());
    expect(created[0]).toMatchObject({ id: "MOV-1", jev: null });
  });

  it("does not double-count a duplicate/restarted admission and keeps the recorded arm after the arm ends", async () => {
    activate({ maxAssignments: 1 });
    await runOnce([issue(1)], ctx());
    expect(jevStore.state(T0)).toMatchObject({ status: "exhausted", assigned: 1 });
    // Restart + retry after exhaustion and after expiry: same recorded arm, no new slot.
    clock = new Date(T0.getTime() + 2 * DAY);
    jevStore = fresh();
    await runOnce([issue(1)], ctx({ jevTrialStore: jevStore }));
    expect(created[1]).toMatchObject({ id: "MOV-1" });
    expect(created[1].jev).toMatchObject({ trialId: "jev-1", assignedAt: T0.toISOString() });
    expect(fresh().state(T0)).toMatchObject({ assigned: 1 });
  });

  it("an off/expired/exhausted/spend-exhausted/invalid arm never admits, and dry-run-style preview agrees with live admission", async () => {
    // Each scenario gets its own config/ledger files -- they are independent
    // arm states, not a sequence of transitions on one arm.
    const scenario = (name) => new JevArmStore({
      configPath: path.join(dir, `${name}.json`),
      ledgerPath: path.join(dir, `${name}-ledger.json`),
      approvedPolicyHashes: [APPROVED_HASH],
    });
    // off
    expect(jevStore.admit(issue(1), { tier: "default", now: T0 }).admitted).toBe(false);
    // invalid
    fs.writeFileSync(path.join(dir, "invalid.json"), JSON.stringify({ enabled: true, trialId: "t", armId: "jev-hosted", policyHash: APPROVED_HASH, allowedWorker: "claude", activatedAt: iso(0), expiresAt: iso(30 * DAY), maxAssignments: 5, spendCeilingUsd: 5 }));
    const invalid = scenario("invalid");
    expect(invalid.state(T0).status).toBe("invalid");
    expect(invalid.admit(issue(1), { tier: "default", now: T0 }).admitted).toBe(false);
    // expired
    const expired = scenario("expired");
    expired.activate({ trialId: "t2", armId: "jev-hosted", policyHash: APPROVED_HASH, expiresAt: iso(1000), maxAssignments: 5, spendCeilingUsd: 5, now: T0 });
    expect(expired.admit(issue(1), { tier: "default", now: new Date(T0.getTime() + 2000) }).admitted).toBe(false);
    // exhausted
    const exhausted = scenario("exhausted");
    exhausted.activate({ trialId: "t3", armId: "jev-hosted", policyHash: APPROVED_HASH, expiresAt: iso(DAY), maxAssignments: 1, spendCeilingUsd: 5, now: T0 });
    exhausted.admit(issue(1), { tier: "default", now: T0 });
    const previewBeforeAdmit = exhausted.state(T0);
    expect(exhausted.admit(issue(2), { tier: "default", now: T0 }).admitted).toBe(false);
    expect(previewBeforeAdmit.assigned).toBe(exhausted.state(T0).assigned); // preview never mutates
    // spend-exhausted
    const spendGone = scenario("spend-gone");
    spendGone.activate({ trialId: "t4", armId: "jev-hosted", policyHash: APPROVED_HASH, expiresAt: iso(DAY), maxAssignments: 5, spendCeilingUsd: 1, now: T0 });
    spendGone.recordSpend({ requestId: "r1", amountUsd: 1 }, T0);
    expect(spendGone.admit(issue(1), { tier: "default", now: T0 }).admitted).toBe(false);
  });

  it("keeps fixed worker:claude/worker:codex pins and the strong-tier upgrade rule completely untouched", () => {
    activate();
    expect(resolveRouting(issue(1, [ELIGIBLE_LABEL, "worker:claude"])).ok).toBe(true);
    const strong = resolveRouting(issue(1, [ELIGIBLE_LABEL, "model:strong"]));
    expect(strong.ok).toBe(false); // still needs an upgrade:* label, jev never bypasses this
  });

  describe("manifest and usage export attribution", () => {
    function fakeChild() {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ type: "result", num_turns: 1, duration_ms: 1000, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n");
        child.stderr.end();
        queueMicrotask(() => child.emit("close", 0));
      });
      return child;
    }

    it("reaches the manifest and the exported usage record, and stays null for unattributed attempts", async () => {
      // The hosted arm now requires a guarded transport. The OSS admission
      // fixture still exercises manifest/usage serialization independently.
      activate({ armId: "jev-oss" });
      const admission = jevStore.admit(issue(1), { tier: "default", now: T0 });
      const attribution = jevAttribution(admission.record);
      const invocation = workerInvocation("claude", "default");
      const logDir = path.join(dir, "attempt");
      await spawnWorker({ invocation, cwd: dir, brief: "fixture", logDir, jev: attribution, spawnImpl: fakeChild });
      const manifest = JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8"));
      expect(manifest.jev).toEqual(attribution);
      captureWorkerUsage(logDir, { issue: "MOV-1", attemptKind: "implementation", worker: "claude", tier: "default", jev: attribution, origin: DISPATCHER_ORIGIN, attemptId: "a1" }, { store: usageStore });

      const baselineDir = path.join(dir, "baseline");
      await spawnWorker({ invocation, cwd: dir, brief: "fixture", logDir: baselineDir, spawnImpl: fakeChild });
      expect(JSON.parse(fs.readFileSync(path.join(baselineDir, "manifest.json"), "utf8")).jev).toBeNull();
      captureWorkerUsage(baselineDir, { issue: "MOV-2", attemptKind: "implementation", worker: "claude", tier: "default", origin: DISPATCHER_ORIGIN, attemptId: "a2" }, { store: usageStore });

      const exported = buildUsageExport(usageStore.recent(), { issues: ["MOV-1", "MOV-2"] });
      const byIssue = Object.fromEntries(exported.runs.map((run) => [run.issue, run]));
      expect(byIssue["MOV-1"].jev).toEqual(attribution);
      expect(byIssue["MOV-2"].jev).toBeNull();
      expect(exported.byIssue.find((row) => row.issue === "MOV-1").jevTrialIds).toEqual(["jev-1"]);
    });

    it("passes the same attribution to usage capture from the run loop, including for a retry after the arm ends", async () => {
      activate();
      const captured = [];
      const captureWorkerUsageFn = (logDir, context) => { captured.push(context); return null; };
      await runOnce([issue(1)], ctx({ captureWorkerUsageFn }));
      clock = new Date(T0.getTime() + 2 * DAY); // arm expired; retry keeps attribution
      await runOnce([issue(1)], ctx({ captureWorkerUsageFn }));
      expect(captured).toHaveLength(2);
      for (const context of captured) {
        expect(context).toMatchObject({ worker: "claude", tier: "default", jev: { trialId: "jev-1", armId: "jev-hosted" } });
      }
    });
  });
});
