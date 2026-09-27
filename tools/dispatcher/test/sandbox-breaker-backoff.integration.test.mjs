// MOV-403: the nested-sandbox breaker's probe schedule across many polls,
// with a persisted store, a frozen clock and a simulated dispatcher restart.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce } from "../src/run-loop.mjs";
import { CircuitBreakerStore } from "../src/circuit-breaker.mjs";
import { NESTED_SANDBOX_CRASH } from "../src/failure-classification.mjs";
import { worktreeName } from "../src/preflight.mjs";
import { promoteEligible } from "../src/promoter.mjs";
import { buildIsIssueSatisfied } from "../src/dependency-gate.mjs";

const STATE_IDS = {
  blocked: "state-blocked",
  agentWorking: "state-agent-working",
  needsHumanDecision: "state-needs-human",
  inReview: "state-in-review",
  readyForAgent: "state-ready-for-agent",
};
const DELEGATE = { id: "actor-dispatcher", name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" };
const T0 = Date.parse("2026-09-27T23:16:40.000Z");
const MIN = 60 * 1000;

function issue(identifier, worker) {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Work ${identifier}`,
    description: "Do the fix.",
    url: `https://linear.app/moviecal/issue/${identifier}`,
    project: null,
    labels: ["execution:mac", `worker:${worker}`],
    delegate: DELEGATE,
    blockedByIds: [],
  };
}

const CODEX_A = issue("MOV-A", "codex");
const CODEX_B = issue("MOV-B", "codex");
const CLAUDE_C = issue("MOV-C", "claude");

function fakeLinearClient() {
  return {
    calls: [],
    async moveToState(issueId, stateId) {
      this.calls.push({ type: "moveToState", issueId, stateId });
    },
    async addComment(issueId, body) {
      this.calls.push({ type: "addComment", issueId, body });
    },
  };
}

function fakeWorktreeManager() {
  return {
    createCalls: [],
    statusCalls: [],
    activeCount: () => 0,
    isPathFree: () => true,
    isPathFreeForIssue: () => true,
    create(args) {
      this.createCalls.push(args);
      return { path: `/fake/worktrees/${args.name}`, ...args };
    },
    prepareWorkerSpawn() {},
    setWorkerPid() {},
    markStatus(id, status, extra = {}) {
      this.statusCalls.push({ id, status, ...extra });
    },
  };
}

const CRASH_LOG = "Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted\n";
const CODEX_SUCCESS_LOG = `${JSON.stringify({
  type: "item.completed",
  item: { id: "c1", type: "command_execution", command: "bash -lc 'git status --short'", aggregated_output: "", exit_code: 0, status: "completed" },
})}\n`;
const CODEX_FAILED_COMMAND_LOG = `${JSON.stringify({
  type: "item.completed",
  item: { id: "c1", type: "command_execution", command: "bash -lc 'npm test'", aggregated_output: "1 failing", exit_code: 1, status: "failed" },
})}\n`;

describe("nested-sandbox breaker probe schedule across polls (MOV-403)", () => {
  let tmpRoot;
  let statePath;
  let clock;
  let linearClient;
  let worktreeManager;
  let spawnWorkerFn;
  // What the next spawned worker writes and returns, keyed by issue.
  let nextRun;

  const now = () => new Date(clock);
  const logDirFor = (target) => path.join(tmpRoot, "logs", worktreeName(target.identifier, target.title));

  function ctx(store) {
    return {
      linearClient,
      stateIds: STATE_IDS,
      worktreeManager,
      dispatcherDelegate: DELEGATE,
      concurrencyLimit: 3,
      workerTimeoutMs: 2_700_000,
      iosRunnerOnline: true,
      secretPresent: () => true,
      worktreeRoot: "/fake/worktrees",
      ghRepo: "owner/repo",
      logRoot: path.join(tmpRoot, "logs"),
      spawnWorkerFn,
      auditWorkerResultFn: () => ({ ok: true, actions: [], violations: [] }),
      repositoryContextFn: () => ({ branch: "b", headSha: "h", baseRef: "origin/master", baseSha: "s", clean: true, recentCommits: [], changedPaths: [] }),
      writeWorkerAuditFn: () => ({ path: "/fake/audit.json", sha256: "abc" }),
      captureVerificationEvidenceFn: () => ({ status: "incomplete" }),
      publishWorkerResultFn: () => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true, headSha: "sha-1" }),
      circuitBreaker: store,
      now,
    };
  }

  function sideEffects() {
    return { spawns: spawnWorkerFn.mock.calls.length, worktrees: worktreeManager.createCalls.length, linear: linearClient.calls.length };
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-breaker-backoff-"));
    statePath = path.join(tmpRoot, "config", "circuit-breakers.json");
    clock = T0;
    linearClient = fakeLinearClient();
    worktreeManager = fakeWorktreeManager();
    nextRun = {};
    spawnWorkerFn = vi.fn(async ({ cwd }) => {
      const target = [CODEX_A, CODEX_B, CLAUDE_C].find((candidate) => cwd.endsWith(worktreeName(candidate.identifier, candidate.title)));
      const run = nextRun[target.identifier];
      const logDir = logDirFor(target);
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), run.log);
      return { exitCode: run.exitCode, logDir };
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("defers until the deadline, admits one probe, backs off, survives restart, and closes only on the adapter's own success", async () => {
    let store = new CircuitBreakerStore(statePath, { now });

    // Poll 1: the first failure trips the breaker for the codex adapter.
    nextRun = { "MOV-A": { exitCode: 71, log: CRASH_LOG } };
    const [first] = await runOnce([CODEX_A], ctx(store));
    expect(first).toMatchObject({ outcome: "nested-sandbox-crash", retryAt: "2026-09-27T23:26:40.000Z" });
    expect(store.status(NESTED_SANDBOX_CRASH, now())).toMatchObject({ open: true, adapter: "codex", due: false, failedProbes: 0 });
    const comment = linearClient.calls.filter((call) => call.type === "addComment").at(-1).body;
    expect(comment).toContain("2026-09-27T23:26:40.000Z");
    expect(comment).toContain("recovery probe on the codex adapter");
    expect(comment).not.toContain("launchctl bootout");

    // Poll 2, one minute before the deadline: nothing spawns, nothing is
    // created, and Linear is untouched, for every simultaneous candidate.
    clock = T0 + 9 * MIN + 59_000;
    let before = sideEffects();
    const deferred = await runOnce([CODEX_A, CODEX_B, CLAUDE_C], ctx(store));
    expect(deferred.map((result) => result.outcome)).toEqual(["circuit-breaker-open", "circuit-breaker-open", "circuit-breaker-open"]);
    expect(deferred[0]).toMatchObject({ retryAt: "2026-09-27T23:26:40.000Z", reason: expect.stringContaining("next recovery probe not before") });
    expect(sideEffects()).toEqual(before);

    // Reconciliation-style passes keep running while dispatch is held.
    const backlog = {
      id: "id-backlog", identifier: "MOV-BACKLOG", stateName: "Backlog",
      description: "## Acceptance criteria\n- x\n\n### Testing Expectations\n- unit: x", labels: [], blockedByIds: [], inverseRelations: [], recentComments: [],
    };
    const promotion = await promoteEligible([backlog], {
      linearClient, readyForAgentStateId: STATE_IDS.readyForAgent, isBlockerSatisfied: buildIsIssueSatisfied([backlog]),
    });
    expect(promotion[0]).toMatchObject({ issue: "MOV-BACKLOG", promoted: true });

    // Poll 3, exactly at the deadline: one probe among three candidates, and
    // only a codex-routed issue may spend it. It fails identically, so the
    // issue is requeued without a duplicate comment and the deadline doubles.
    clock = T0 + 10 * MIN;
    nextRun = { "MOV-A": { exitCode: 71, log: CRASH_LOG } };
    const sandboxComments = () => linearClient.calls.filter((call) => call.type === "addComment" && call.body.includes("Environment failure"));
    const commentsBefore = sandboxComments().length;
    const probed = await runOnce([CLAUDE_C, CODEX_A, CODEX_B], ctx(store));
    expect(probed.map((result) => result.outcome)).toEqual(["circuit-breaker-open", "nested-sandbox-crash", "circuit-breaker-open"]);
    expect(probed[0].reason).toContain("must run on the affected adapter");
    expect(spawnWorkerFn).toHaveBeenCalledTimes(2);
    expect(sandboxComments()).toHaveLength(commentsBefore);
    expect(linearClient.calls.at(-1)).toMatchObject({ type: "moveToState", issueId: "id-MOV-A", stateId: STATE_IDS.readyForAgent });
    expect(linearClient.calls.some((call) => call.issueId === "id-MOV-B" || call.issueId === "id-MOV-C")).toBe(false);
    expect(store.status(NESTED_SANDBOX_CRASH, now())).toMatchObject({ failedProbes: 1, nextProbeAt: "2026-09-27T23:46:40.000Z" });

    // Restart: a fresh store instance reads the same deadline and history.
    store = new CircuitBreakerStore(statePath, { now });
    clock = T0 + 29 * MIN;
    before = sideEffects();
    expect((await runOnce([CODEX_A, CODEX_B], ctx(store))).map((result) => result.outcome)).toEqual(["circuit-breaker-open", "circuit-breaker-open"]);
    expect(sideEffects()).toEqual(before);

    // Poll 5: the due probe exits 0 but never completes a command. That is
    // not recovery: the breaker stays open and backs off again.
    clock = T0 + 30 * MIN;
    nextRun = { "MOV-B": { exitCode: 0, log: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "No changes needed." } })}\n` } };
    const [, noEvidence] = await runOnce([CLAUDE_C, CODEX_B], ctx(store));
    expect(noEvidence.outcome).not.toBe("circuit-breaker-open");
    expect(store.status(NESTED_SANDBOX_CRASH, now())).toMatchObject({ open: true, failedProbes: 2, nextProbeAt: "2026-09-28T00:26:40.000Z" });

    // Poll 6: an ordinary failed command is not recovery either.
    clock = Date.parse(store.status(NESTED_SANDBOX_CRASH, now()).nextProbeAt);
    nextRun = { "MOV-A": { exitCode: 1, log: CODEX_FAILED_COMMAND_LOG } };
    const [ordinary] = await runOnce([CODEX_A], ctx(store));
    expect(ordinary.outcome).toBe("worker-failed");
    expect(store.status(NESTED_SANDBOX_CRASH, now())).toMatchObject({ open: true, failedProbes: 3 });

    // Poll 7: a codex worker completes a local command successfully. Only
    // this closes the breaker, and it records the evidence.
    clock = Date.parse(store.status(NESTED_SANDBOX_CRASH, now()).nextProbeAt);
    nextRun = { "MOV-B": { exitCode: 0, log: CODEX_SUCCESS_LOG } };
    await runOnce([CODEX_B], ctx(store));
    expect(store.isOpen(NESTED_SANDBOX_CRASH)).toBe(false);
    expect(store.load()[NESTED_SANDBOX_CRASH].recoveredBy).toEqual({
      adapter: "codex",
      evidence: expect.stringContaining("git status --short"),
    });

    // Dispatch resumes for every adapter.
    nextRun = { "MOV-C": { exitCode: 0, log: "" } };
    const [resumed] = await runOnce([CLAUDE_C], ctx(store));
    expect(resumed.outcome).not.toBe("circuit-breaker-open");
  });

  it("an operator-authorized probe runs before the deadline without deleting state, and another adapter cannot claim it", async () => {
    const store = new CircuitBreakerStore(statePath, { now });
    nextRun = { "MOV-A": { exitCode: 71, log: CRASH_LOG } };
    await runOnce([CODEX_A], ctx(store));

    clock = T0 + MIN;
    store.authorizeProbe(NESTED_SANDBOX_CRASH, { by: "adam" });
    const before = sideEffects();
    const [onlyClaude] = await runOnce([CLAUDE_C], ctx(store));
    expect(onlyClaude.outcome).toBe("circuit-breaker-open");
    expect(sideEffects()).toEqual(before);

    nextRun = { "MOV-B": { exitCode: 71, log: CRASH_LOG } };
    const [probe] = await runOnce([CODEX_B], ctx(store));
    expect(probe.outcome).toBe("nested-sandbox-crash");
    const record = store.load()[NESTED_SANDBOX_CRASH];
    expect(record.history.map((entry) => entry.issue)).toEqual(["MOV-A", "MOV-B"]);
    expect(record.failedProbes).toBe(1);
    expect(record.operatorProbe).toBeNull();
    // A different issue hitting the breaker still gets its own comment.
    expect(linearClient.calls.filter((call) => call.type === "addComment" && call.issueId === "id-MOV-B" && call.body.includes("Environment failure"))).toHaveLength(1);
  });
});
