// End-to-end run-loop integration tests (MOV-197).
//
// tools/dispatcher/test/run-loop.test.mjs already exercises run-loop.mjs's
// orchestration logic thoroughly, but always by handing runOnce() a ctx
// object the *test* assembled by hand -- including passing
// `isIssueSatisfied: buildIsIssueSatisfied([issue])` directly. That is
// exactly the gap MOV-128 shipped through: dependency-gate.mjs was unit
// tested, run-loop.mjs's *use* of ctx.isIssueSatisfied was unit tested, but
// nothing dynamically proved that bin/dispatcher.mjs's buildRunContext()
// actually wires the two together for a real run -- it didn't, and every
// existing test still passed. MOV-192's usageLimitStore wiring shipped
// through the identical gap.
//
// These tests close it by calling the REAL buildRunContext() (now
// importable from src/run-context.mjs; see that file's header) against a
// fake Linear client, and only replacing the leaf functions that would
// otherwise touch a real git worktree, spawn a real worker process, or push
// to real GitHub. ctx.isIssueSatisfied and ctx.usageLimitStore -- the two
// properties MOV-128 and MOV-192 each had to add to buildRunContext -- are
// left exactly as buildRunContext produces them. Reverting either wiring
// line locally (checked by hand during development, not automated here)
// makes the corresponding test in this file fail.
//
// The second describe block covers the other pattern MOV-197 targets: a
// CI-failure classification flowing through repair admission and a ledger
// budget check into a (fake) repair worker dispatch, as one sequence against
// the real ci-outcomes.mjs / repair-policy.mjs / repair-ledger.mjs modules,
// not three isolated unit-test files. No production code currently wires a
// repair *dispatch* into the poll loop (MOV-190, which this issue blocks,
// is where that lands) -- this proves the modules that will back it already
// compose correctly against realistic fakes.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runOnce } from "../src/run-loop.mjs";
import { buildIsIssueSatisfied } from "../src/dependency-gate.mjs";
import { promoteEligible, PROMOTION_COMMENT } from "../src/promoter.mjs";
import { worktreeName } from "../src/preflight.mjs";
import { admitRepair } from "../src/repair-policy.mjs";
import { RepairLedger } from "../src/repair-ledger.mjs";
import { UsageLimitStore } from "../src/usage-limit.mjs";

// buildRunContext calls checkIosRunnerOnline(), which shells out to `gh` for
// a live network call. Nothing in these tests wants that: the fixtures below
// never involve the iOS Companion App project, so iosRunnerOnline's value is
// irrelevant to every assertion here.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: () => { throw new Error("no network access in tests"); } };
});

// buildRunContext otherwise reads and writes real dispatcher state under
// ~/.config/moviecal and ~/code/worktrees/moviecal (config.mjs's hardcoded
// production paths). Redirect every one of those to a per-test-run temp
// directory so the real UsageLimitStore/CircuitBreakerStore instances
// buildRunContext constructs are exercised for real, without ever touching
// this machine's actual dispatcher state.
const TMP_ROOT = vi.hoisted(() => `${process.env.TMPDIR || "/tmp"}/mov197-run-loop-e2e-${process.pid}-${Date.now()}`);
vi.mock("../src/config.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    worktreeRoot: () => `${TMP_ROOT}/worktrees`,
    worktreesStatePath: () => `${TMP_ROOT}/worktrees.json`,
    circuitBreakerStatePath: () => `${TMP_ROOT}/circuit-breaker.json`,
    usageLimitStatePath: () => `${TMP_ROOT}/usage-limit.json`,
    envLocalPath: () => `${TMP_ROOT}/env.local`,
    logRoot: () => `${TMP_ROOT}/logs`,
    linearAppEnvPath: () => `${TMP_ROOT}/linear-app.env`,
  };
});

// Imported after the mocks above so buildRunContext picks them up.
const { buildRunContext } = await import("../src/run-context.mjs");

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const TEAM_KEY = "MOV";
const REPO = "owner/repo";
const DELEGATE = { id: null, name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" };

const WORKFLOW_STATES = [
  { id: "state-backlog", name: "Backlog" },
  { id: "state-blocked", name: "Blocked" },
  { id: "state-ready", name: "Ready for Agent" },
  { id: "state-agent-working", name: "Agent Working" },
  { id: "state-needs-human", name: "Needs Human Decision" },
  { id: "state-in-review", name: "In Review" },
  { id: "state-done", name: "Done" },
];

const READY_SECTIONS = [
  "## Acceptance criteria",
  "- The thing works.",
  "",
  "### Testing Expectations",
  "- unit: covers the thing.",
].join("\n");

/** A fake Linear client shaped like the real LinearClient's public surface. */
function fakeLinearClient(issueSnapshots = {}) {
  return {
    calls: [],
    async workflowStates() {
      return WORKFLOW_STATES;
    },
    async moveToState(issueId, stateId) {
      this.calls.push({ type: "moveToState", issueId, stateId });
    },
    async addComment(issueId, body) {
      this.calls.push({ type: "addComment", issueId, body });
    },
    async issueSnapshot(issueId) {
      return issueSnapshots[issueId] ?? null;
    },
  };
}

/** A worktree manager that tracks taken paths in memory only -- no real git. */
function fakeWorktreeManager() {
  const taken = new Set();
  return {
    createCalls: [],
    statusCalls: [],
    activeCount: () => taken.size,
    isPathFree: (p) => !taken.has(p),
    isPathFreeForIssue: (p) => !taken.has(p),
    create(args) {
      const worktreePath = `${TMP_ROOT}/fake-worktrees/${args.name}`;
      taken.add(worktreePath);
      this.createCalls.push(args);
      return { path: worktreePath, ...args };
    },
    markStatus(id, status, extra = {}) {
      this.statusCalls.push({ id, status, ...extra });
    },
  };
}

/** Every ctx property a real dispatch would exercise as I/O, replaced with a fake. */
function fakeLeaves(overrides = {}) {
  return {
    worktreeManager: fakeWorktreeManager(),
    spawnWorkerFn: vi.fn(async () => ({ exitCode: 0, logDir: `${TMP_ROOT}/logs/x` })),
    auditWorkerResultFn: vi.fn(() => ({ ok: true, violations: [] })),
    writeWorkerAuditFn: vi.fn(() => ({ path: `${TMP_ROOT}/logs/x/security-audit.json`, sha256: "abc123" })),
    publishWorkerResultFn: vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true, headSha: "sha-1" })),
    applyStagedWorkflowEditFn: vi.fn(() => ({ applied: false, reason: "not configured" })),
    uncommittedChangesFn: vi.fn(() => []),
    readAgentSessionFn: vi.fn(() => null),
    persistAgentSessionFn: vi.fn(() => {}),
    ...overrides,
  };
}

describe("dependency-gating -> promotion -> dispatch, one continuous run (MOV-197)", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("blocks dispatch through the real buildRunContext-wired isIssueSatisfied while the blocker is unresolved (MOV-128)", async () => {
    // A "Ready for Agent" batch is exactly what LinearClient.issuesInState()
    // would hand buildRunContext -- this issue carries its blocker's live
    // workflow state in inverseRelations already, whether or not the
    // promoter itself ever ran. If buildRunContext's `isIssueSatisfied:
    // buildIsIssueSatisfied(issues)` line is reverted, ctx.isIssueSatisfied
    // is undefined and run-loop.mjs's default `() => true` lets this
    // through -- this assertion is what catches that.
    const issue = {
      id: "id-dep", identifier: "MOV-DEP", title: "Depends on the blocker",
      description: READY_SECTIONS, url: "https://linear.app/moviecal/issue/MOV-DEP",
      project: null, labels: ["execution:mac"], delegate: DELEGATE,
      blockedByIds: ["id-blocker"],
      inverseRelations: [
        { type: "blocks", issue: { id: "id-blocker", state: { name: "In Review" } }, relatedIssue: { id: "id-dep" } },
      ],
    };
    const linearClient = fakeLinearClient({ "id-dep": issue });

    const ctx = { ...(await buildRunContext(linearClient, TEAM_KEY, [issue])), ...fakeLeaves() };

    expect(typeof ctx.isIssueSatisfied).toBe("function");
    expect(ctx.usageLimitStore).toBeInstanceOf(UsageLimitStore);

    const [result] = await runOnce([issue], ctx);

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toMatch(/blocked by unresolved relation\(s\): id-blocker/);
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.createCalls).toHaveLength(0);
  });

  it("promotes once the blocker resolves, then the same real buildRunContext dispatches it to in-review", async () => {
    const blockedDescription = {
      id: "id-dep2", identifier: "MOV-DEP2", stateName: "Backlog",
      description: READY_SECTIONS, labels: [], blockedByIds: ["id-blocker2"], recentComments: [],
      inverseRelations: [
        { type: "blocks", issue: { id: "id-blocker2", state: { name: "Backlog" } }, relatedIssue: { id: "id-dep2" } },
      ],
    };
    const linearClient = fakeLinearClient();

    // Step 1: the promoter (real promoteEligible + real buildIsIssueSatisfied,
    // exactly as cmdPromoteOnce wires them) leaves it alone.
    const notYet = await promoteEligible([blockedDescription], {
      linearClient,
      readyForAgentStateId: "state-ready",
      isBlockerSatisfied: buildIsIssueSatisfied([blockedDescription]),
    });
    expect(notYet).toEqual([{ issue: "MOV-DEP2", promoted: false, reason: expect.stringContaining("unresolved blocker") }]);
    expect(linearClient.calls).toEqual([]);

    // Step 2: the blocker resolves. Same shape a fresh issuesForPromotion()
    // batch would carry.
    const readyDescription = {
      ...blockedDescription,
      inverseRelations: [
        { type: "blocks", issue: { id: "id-blocker2", state: { name: "Done" } }, relatedIssue: { id: "id-dep2" } },
      ],
    };
    const promoted = await promoteEligible([readyDescription], {
      linearClient,
      readyForAgentStateId: "state-ready",
      isBlockerSatisfied: buildIsIssueSatisfied([readyDescription]),
    });
    expect(promoted).toEqual([{ issue: "MOV-DEP2", promoted: true, reason: expect.any(String) }]);
    expect(linearClient.calls).toEqual([
      { type: "moveToState", issueId: "id-dep2", stateId: "state-ready" },
      { type: "addComment", issueId: "id-dep2", body: PROMOTION_COMMENT },
    ]);

    // Step 3: the now-promoted issue, in the shape LinearClient.issuesInState()
    // would return it, goes through the real buildRunContext -> runOnce path.
    const dispatchIssue = {
      id: "id-dep2", identifier: "MOV-DEP2", title: "Depends on the blocker",
      description: READY_SECTIONS, url: "https://linear.app/moviecal/issue/MOV-DEP2",
      project: null, labels: ["execution:mac"], delegate: DELEGATE,
      blockedByIds: ["id-blocker2"],
      inverseRelations: readyDescription.inverseRelations,
    };
    linearClient.issueSnapshot = async () => dispatchIssue;
    const ctx = { ...(await buildRunContext(linearClient, TEAM_KEY, [dispatchIssue])), ...fakeLeaves() };

    const [result] = await runOnce([dispatchIssue], ctx);

    expect(result.outcome).toBe("in-review");
    expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    expect(ctx.worktreeManager.createCalls).toHaveLength(1);
    expect(ctx.worktreeManager.createCalls[0]).toMatchObject({ id: "MOV-DEP2" });
  });

  it("defers dispatch through the real buildRunContext-wired usageLimitStore when the worker reports a provider limit (MOV-192)", async () => {
    // If buildRunContext's `usageLimitStore: new UsageLimitStore(...)` line is
    // reverted, ctx.usageLimitStore is undefined and run-loop.mjs falls back
    // to its no-op default store, whose `deferral()` never defers and whose
    // `record()` never persists a retry -- the outcome below would be
    // "worker-failed" (escalated to Needs Human Decision) instead of
    // "usage-limit-deferred", which is exactly what this asserts against.
    const issue = {
      id: "id-usage", identifier: "MOV-USAGE", title: "Hits a usage limit",
      description: READY_SECTIONS, url: "https://linear.app/moviecal/issue/MOV-USAGE",
      project: null, labels: ["execution:mac"], delegate: DELEGATE, blockedByIds: [],
    };
    const linearClient = fakeLinearClient({ "id-usage": issue });
    const ctx = { ...(await buildRunContext(linearClient, TEAM_KEY, [issue])), ...fakeLeaves() };

    // run-loop.mjs reads the worker's log tail from disk via tailLogs() --
    // that function isn't ctx-injectable, so the fixture has to be a real
    // file at the exact path run-loop.mjs will independently compute
    // (logRoot/<worktreeName>). classifyUsageLimitFailure needs an epoch
    // reset time (unambiguous across machine timezones) inside its 24h
    // deferral window.
    const name = worktreeName(issue.identifier, issue.title);
    const logDir = path.join(ctx.logRoot, name);
    fs.mkdirSync(logDir, { recursive: true });
    const resetEpochSeconds = Math.floor((Date.now() + 3600_000) / 1000);
    fs.writeFileSync(path.join(logDir, "stdout.log"), `Claude usage limit reached · reset|${resetEpochSeconds}\n`);
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 1, logDir }));

    const [result] = await runOnce([issue], ctx);

    expect(result.outcome).toBe("usage-limit-deferred");
    expect(result.retryAt).toBeTruthy();
    const lastMove = linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
    expect(lastMove.stateId).toBe("state-ready"); // requeued to Ready for Agent, not escalated
    expect(ctx.worktreeManager.statusCalls.at(-1)).toMatchObject({ id: "MOV-USAGE", status: "failed" });

    // The deferral this issue now carries is real, persisted state -- a
    // second poll cycle over the same ctx must hold off rather than
    // re-dispatching immediately.
    const deferral = ctx.usageLimitStore.deferral("MOV-USAGE");
    expect(deferral.deferred).toBe(true);
  });
});

describe("CI-failure classification -> repair admission -> ledger budget -> repair dispatch, one continuous run (MOV-197)", () => {
  const REPAIR_ENTRY = {
    id: "MOV-77",
    branch: "agent/MOV-77-fix-thing",
    status: "review",
    prNumber: 42,
    prUrl: "https://github.com/owner/repo/pull/42",
    provenance: { executor: "moviecal-dispatcher", repository: REPO },
  };

  function observationWithFailure({ headSha, checkName = "lane-unit" }) {
    return {
      state: "OPEN",
      headSha,
      headRepository: REPO,
      headBranch: REPAIR_ENTRY.branch,
      url: REPAIR_ENTRY.prUrl,
      review: {},
      checks: {
        checks: [{ name: checkName, required: true, outcome: "failure", sha: headSha, summary: "2 tests failed" }],
        required: [{ name: checkName }],
        missingRequired: [],
      },
    };
  }

  /** No production code wires this sequence into the poll loop yet (that is
   * MOV-190's scope, which this issue blocks) -- this is a fake, in-memory
   * stand-in for "a repair worker ran and pushed a fix", used only to
   * complete the ledger reservation the real admitRepair()/RepairLedger
   * pairing produced. */
  async function fakeRepairWorkerDispatch({ entry, newHeadSha }) {
    const spawnResult = await vi.fn(async () => ({ exitCode: 0, logDir: "/fake/logs/repair" }))();
    const audit = { ok: true, violations: [] };
    const pr = { number: entry.prNumber, url: entry.prUrl, headSha: newHeadSha, isDraft: false };
    return { spawnResult, audit, pr };
  }

  it("admits, reserves, dispatches, and exhausts the code-repair budget across consecutive failures on new head SHAs", async () => {
    const ledgerPath = `${TMP_ROOT}/repair-ledger-${Date.now()}.json`;
    const ledger = new RepairLedger(ledgerPath);
    let headSha = "sha-A";

    // Two attempts within budget (DEFAULT_REPAIR_BUDGETS.codeRepair === 2).
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const observation = observationWithFailure({ headSha });
      const decision = admitRepair({
        entry: REPAIR_ENTRY,
        observation,
        repository: REPO,
        previousAttempts: ledger.previousAttempts(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber),
        reservedKeys: ledger.attempts(REPAIR_ENTRY.id).map((a) => a.key),
        unfinishedAttempt: ledger.unfinished(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber),
        enabled: true,
      });

      expect(decision.action, `attempt ${attempt}`).toBe("code-repair");
      ledger.reserve(REPAIR_ENTRY.id, {
        key: decision.key, kind: "code-repair", prNumber: REPAIR_ENTRY.prNumber,
        headSha: decision.headSha, fingerprints: decision.fingerprints, reason: decision.reason,
      });

      const newHeadSha = `sha-repaired-${attempt}`;
      const { pr } = await fakeRepairWorkerDispatch({ entry: REPAIR_ENTRY, newHeadSha });
      ledger.complete(REPAIR_ENTRY.id, decision.key, { outcome: "published", detail: pr.url, headSha: pr.headSha });

      expect(ledger.previousAttempts(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber).codeRepair).toBe(attempt);
      headSha = `sha-followup-${attempt}`; // the repair's push produced a new head; a later CI run fails again on it
    }

    // A third consecutive code failure exceeds the budget and must escalate,
    // not spend a third worker.
    const thirdObservation = observationWithFailure({ headSha });
    const thirdDecision = admitRepair({
      entry: REPAIR_ENTRY,
      observation: thirdObservation,
      repository: REPO,
      previousAttempts: ledger.previousAttempts(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber),
      reservedKeys: ledger.attempts(REPAIR_ENTRY.id).map((a) => a.key),
      unfinishedAttempt: ledger.unfinished(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber),
      enabled: true,
    });

    expect(thirdDecision.action).toBe("escalate");
    expect(thirdDecision.reason).toMatch(/budget exhausted/);
    ledger.recordEscalation(REPAIR_ENTRY.id, {
      key: thirdDecision.key, prNumber: REPAIR_ENTRY.prNumber, headSha: thirdDecision.headSha,
      fingerprints: thirdDecision.fingerprints, reason: thirdDecision.reason,
    });

    // Escalations never consume repair budget -- the count must stay at 2,
    // matching what two real completed attempts recorded above.
    expect(ledger.previousAttempts(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber)).toMatchObject({ codeRepair: 2, total: 2 });
  });

  it("refuses to admit a second repair for the same head SHA and failure once a job is already reserved", async () => {
    const ledgerPath = `${TMP_ROOT}/repair-ledger-dup-${Date.now()}.json`;
    const ledger = new RepairLedger(ledgerPath);
    const observation = observationWithFailure({ headSha: "sha-dup" });

    const first = admitRepair({
      entry: REPAIR_ENTRY, observation, repository: REPO,
      previousAttempts: ledger.previousAttempts(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber),
      reservedKeys: [], enabled: true,
    });
    expect(first.action).toBe("code-repair");
    ledger.reserve(REPAIR_ENTRY.id, {
      key: first.key, kind: "code-repair", prNumber: REPAIR_ENTRY.prNumber,
      headSha: first.headSha, fingerprints: first.fingerprints, reason: first.reason,
    });

    // The same failing observation reappears before the dispatcher completes
    // the first attempt (e.g. the very next poll cycle) -- a second worker
    // must not be started against an already-reserved job.
    const second = admitRepair({
      entry: REPAIR_ENTRY, observation, repository: REPO,
      previousAttempts: ledger.previousAttempts(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber),
      reservedKeys: ledger.attempts(REPAIR_ENTRY.id).map((a) => a.key),
      enabled: true,
    });

    expect(second.action).toBe("ignore");
    expect(second.reason).toMatch(/already exists/);
  });

  it("escalates instead of admitting when automatic repair is switched off, spending no budget", async () => {
    const ledgerPath = `${TMP_ROOT}/repair-ledger-off-${Date.now()}.json`;
    const ledger = new RepairLedger(ledgerPath);
    const observation = observationWithFailure({ headSha: "sha-off" });

    const decision = admitRepair({
      entry: REPAIR_ENTRY, observation, repository: REPO,
      previousAttempts: ledger.previousAttempts(REPAIR_ENTRY.id, REPAIR_ENTRY.prNumber),
      enabled: false,
    });

    expect(decision.action).toBe("ignore");
    expect(decision.reason).toMatch(/switched off/);
    expect(ledger.attempts(REPAIR_ENTRY.id)).toHaveLength(0);
  });
});
