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
import { auditIssueSpecs, AUDIT_COMMENT_HEADLINE } from "../src/issue-spec-audit.mjs";
import { branchName, worktreeName } from "../src/preflight.mjs";
import { admitRepair } from "../src/repair-policy.mjs";
import { RepairLedger } from "../src/repair-ledger.mjs";
import { UsageLimitStore } from "../src/usage-limit.mjs";
import { WorkerCooldownStore } from "../src/worker-cooldown.mjs";
import { CircuitBreakerStore } from "../src/circuit-breaker.mjs";
import { CREDENTIAL_FAILURE } from "../src/credential-failure.mjs";
import { NESTED_SANDBOX_CRASH } from "../src/failure-classification.mjs";
import { DEFAULT_ISSUE_SPEC_MODE } from "../src/issue-spec.mjs";

// MOV-179: the real diagnosis adapter makes a live Anthropic API call.
// Nothing in this file wants that -- the point of the describe block below is
// to prove buildRunContext() actually wires `diagnoseFailureFn` to
// worker-diagnosis.mjs's export, not to re-test that module's own network
// call (worker-diagnosis.test.mjs already does). Mocking at the module
// boundary, rather than overriding ctx.diagnoseFailureFn by hand the way
// fakeLeaves() does for other leaves, is what makes this test fail if the
// wiring line in run-context.mjs is ever reverted: an overridden ctx value
// would mask that regression completely.
const diagnoseUnrecognizedFailureMock = vi.hoisted(() => vi.fn());
vi.mock("../src/worker-diagnosis.mjs", () => ({
  diagnoseUnrecognizedFailure: diagnoseUnrecognizedFailureMock,
}));

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
    workerCooldownStatePath: () => `${TMP_ROOT}/worker-cooldowns.json`,
    envLocalPath: () => `${TMP_ROOT}/env.local`,
    logRoot: () => `${TMP_ROOT}/logs`,
    linearAppEnvPath: () => `${TMP_ROOT}/linear-app.env`,
    // `resolveDispatcherDelegate()` resolves its default path argument from
    // config.mjs's own module-scope `linearAppEnvPath`, which the override
    // above cannot intercept -- so without this it reads this machine's real
    // `~/.config/moviecal/linear-app.env` and fails wherever that file is
    // present but unreadable (e.g. under the worker sandbox, which denies
    // credential stores by design). Re-anchor it on the same temp directory
    // as every other path here; the real function still runs.
    resolveDispatcherDelegate: () => actual.resolveDispatcherDelegate({ linearAppPath: `${TMP_ROOT}/linear-app.env` }),
    // Every fixture below is a minimal `READY_SECTIONS`-only issue, not a
    // fully labeled one -- the issue-completeness contract (MOV-303) would
    // refuse every one of them under `enforce` mode. Without this override,
    // `resolveIssueSpecMode()` reads this Mac's real
    // `MOVIECAL_ISSUE_SPEC_MODE`, so a machine an operator has switched to
    // `enforce` (the documented post-backfill step, §Automated promotion)
    // fails every test in this file with an unrelated issue-spec reason
    // instead of the dependency/credential/usage-limit behavior each one
    // means to exercise. Pin it to the shipped default so this file's
    // fixtures are deterministic regardless of the host environment, same as
    // every other real-path override above.
    resolveIssueSpecMode: () => DEFAULT_ISSUE_SPEC_MODE,
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

/**
 * A fuller in-memory stand-in for WorktreeManager: it keeps a real registry
 * across poll cycles and implements the ownership/integrity/resume surface
 * MOV-205's re-admission reads. Still no real git — the point is to prove the
 * *lifecycle transition* (retained -> deferred -> resumed in place) is driven
 * by the real UsageLimitStore buildRunContext wires, not to re-test
 * WorktreeManager's own shell-outs, which worktree-manager.test.mjs covers.
 */
function statefulWorktreeRegistry({ owned = true, integrityBranch = null } = {}) {
  const state = {};
  return {
    createCalls: [],
    statusCalls: [],
    resumeCalls: [],
    reclaimChecks: [],
    state,
    activeCount: () => Object.values(state).filter((e) => e.status === "active").length,
    isPathFree: (p) => !Object.values(state).some((e) => e.path === p),
    isPathFreeForIssue(p, id) {
      this.reclaimChecks.push({ path: p, issue: id });
      return !Object.values(state).some((e) => e.path === p);
    },
    loadState: () => state,
    isDispatcherOwnedWorktree: () => owned,
    worktreeIntegrity(p, branch) {
      const entry = Object.values(state).find((e) => e.path === p);
      const actual = integrityBranch ?? entry?.branch ?? null;
      if (!entry) return { intact: false, branch: null, reason: `no worktree at ${p}` };
      if (branch && actual !== branch) return { intact: false, branch: actual, reason: `worktree at ${p} is on ${actual}, not ${branch}` };
      return { intact: true, branch: actual, reason: null };
    },
    create(args) {
      this.createCalls.push(args);
      const entry = {
        ...args,
        // Deliberately the same `worktreeRoot()/<name>` the real
        // WorktreeManager.create() uses and that run-loop.mjs independently
        // recomputes as the dispatch target -- MOV-205's re-admission requires
        // the registry entry and that computed path to agree.
        path: path.join(`${TMP_ROOT}/worktrees`, args.name),
        status: "active",
        provenance: { executor: "moviecal-dispatcher", repository: args.repository || null },
      };
      state[args.id] = entry;
      return entry;
    },
    markStatus(id, status, extra = {}) {
      this.statusCalls.push({ id, status, ...extra });
      state[id] = { ...state[id], status, endedAt: "stamped", ...extra };
      return state[id];
    },
    resumeEntry(id, opts) {
      this.resumeCalls.push({ id, ...opts });
      const entry = { ...state[id], status: "active", resumeCount: (state[id].resumeCount || 0) + 1 };
      delete entry.usageLimitResumeAt;
      delete entry.retainedForResume;
      state[id] = entry;
      return entry;
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
    expect(notYet).toEqual([
      { issue: "MOV-DEP2", promoted: false, reason: expect.stringContaining("unresolved blocker"), specViolations: expect.any(Array) },
    ]);
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
    expect(promoted).toEqual([
      { issue: "MOV-DEP2", promoted: true, reason: expect.any(String), specViolations: expect.any(Array) },
    ]);
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

  // MOV-205. The lifecycle MOV-192 could not reach: the provider limit landed
  // *after* the worker produced unpublished changes, so the deferred attempt
  // has to resume the retained worktree rather than be handed to a human.
  //
  // Run as one continuous sequence of three real poll cycles against the same
  // ctx -- deferral, hold, resume -- because the property worth proving is the
  // transition between them, and specifically that the third cycle produces
  // NO reclaim and NO new worktree. Three isolated unit tests could each pass
  // while the handoff between them lost the plan.
  it("retains, holds, then resumes the same worktree in place across three real poll cycles (MOV-205)", async () => {
    const issue = {
      id: "id-resume", identifier: "MOV-RESUME", title: "Hits a usage limit mid-implementation",
      description: READY_SECTIONS, url: "https://linear.app/moviecal/issue/MOV-RESUME",
      project: null, labels: ["execution:mac"], delegate: DELEGATE, blockedByIds: [],
    };
    const linearClient = fakeLinearClient({ "id-resume": issue });
    const unpublished = ["src/app/page.tsx"];
    const ctx = {
      ...(await buildRunContext(linearClient, TEAM_KEY, [issue])),
      ...fakeLeaves({
        worktreeManager: statefulWorktreeRegistry(),
        uncommittedChangesFn: vi.fn(() => unpublished),
      }),
    };
    const manager = ctx.worktreeManager;

    // tailLogs() reads from disk at a path run-loop.mjs computes itself.
    const name = worktreeName(issue.identifier, issue.title);
    const logDir = path.join(ctx.logRoot, name);
    fs.mkdirSync(logDir, { recursive: true });
    const resetEpochSeconds = Math.floor((Date.now() + 3600_000) / 1000);
    fs.writeFileSync(path.join(logDir, "stdout.log"), `Claude usage limit reached · reset|${resetEpochSeconds}\n`);
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 1, logDir }));

    // Cycle 1 -- the limit lands on a dirty worktree. Pre-MOV-205 this was
    // "worker-failed" into Needs Human Decision.
    const [deferred] = await runOnce([issue], ctx);
    expect(deferred.outcome).toBe("usage-limit-resume-deferred");
    expect(deferred.uncommittedPaths).toEqual(unpublished);
    expect(linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-ready");
    expect(manager.state["MOV-RESUME"]).toMatchObject({ status: "failed", retainedForResume: true });
    // Both durable halves agree -- this is what re-admission cross-checks.
    const plan = ctx.usageLimitStore.get("MOV-RESUME").resume;
    expect(plan.worktreePath).toBe(manager.state["MOV-RESUME"].path);
    expect(plan.retryAt).toBe(manager.state["MOV-RESUME"].usageLimitResumeAt);

    // Cycle 2 -- before the reset. Silent, and claims nothing. The real
    // buildRunContext-wired workerCooldownStore (MOV-360) now gates this
    // batch-wide, before dispatchIssue's own per-issue deferral check ever
    // runs -- cycle 1's classification set *both* durable records, so this
    // issue's own retry is still exactly as bounded as before, just reported
    // under the more general worker-cooldown outcome every same-worker issue
    // shares during the wait.
    const callsBeforeHold = linearClient.calls.length;
    const [held] = await runOnce([issue], ctx);
    expect(held.outcome).toBe("deferred-worker-cooldown");
    expect(linearClient.calls.length).toBe(callsBeforeHold);
    expect(manager.createCalls).toHaveLength(1); // still just cycle 1's
    expect(manager.resumeCalls).toHaveLength(0);

    // The record survives a dispatcher restart: a brand-new store over the
    // same on-disk path is still holding this issue back.
    expect(new UsageLimitStore(`${TMP_ROOT}/usage-limit.json`).deferral("MOV-RESUME").deferred).toBe(true);

    // Cycle 3 -- the provider reset has passed. The worker gets a session and
    // finishes the work it had already started.
    ctx.now = () => new Date(Date.now() + 2 * 3600_000);
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 0, logDir }));
    // Cycle 1's own fresh dispatch legitimately consulted the reclaim check on
    // an empty path; what must not happen is a *new* one now, on a path that
    // is occupied by real unpublished work.
    const reclaimChecksBeforeResume = manager.reclaimChecks.length;

    const [resumed] = await runOnce([issue], ctx);

    expect(resumed.reason ?? null).toBeNull();
    expect(resumed.outcome).toBe("in-review");
    // The whole point: same worktree, same branch, resumed rather than rebuilt.
    expect(manager.resumeCalls).toEqual([
      { id: "MOV-RESUME", worktreePath: manager.state["MOV-RESUME"].path, branch: branchName(issue.identifier, issue.title) },
    ]);
    expect(manager.createCalls).toHaveLength(1); // no second worktree, ever
    expect(manager.reclaimChecks).toHaveLength(reclaimChecksBeforeResume); // the reclaim path is never consulted
    expect(ctx.spawnWorkerFn.mock.calls[0][0].cwd).toBe(manager.state["MOV-RESUME"].path);
    expect(ctx.spawnWorkerFn.mock.calls[0][0].brief).toContain("You are resuming an interrupted attempt");

    // The plan is spent and the clean publication forgot the history, so a
    // fourth cycle would be an ordinary dispatch again.
    expect(ctx.usageLimitStore.resumption("MOV-RESUME", ctx.now())).toBeNull();
    expect(ctx.usageLimitStore.get("MOV-RESUME")).toBeNull();
  });
});

// MOV-360: pausing dispatch of a whole worker quota pool after a provider
// usage limit, driven through the real buildRunContext -> runOnce seam (not
// hand-assembled fakes) -- the acceptance criteria this issue names for the
// integration layer: exact worker spawn/worktree counts across one batch,
// Codex-pinned and fresh worker:any progress during a Claude cooldown, the
// original worker preserved on a deferred worker:any retry across a restart,
// due-retry probe priority, and no same-batch cascade after the refusal.
describe("worker-quota-pool cooldown across the real dispatcher wiring (MOV-360)", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  function makeIssue({ id, identifier, title, labels = [] }) {
    return {
      id,
      identifier,
      title,
      description: READY_SECTIONS,
      url: `https://linear.app/moviecal/issue/${identifier}`,
      project: null,
      labels: ["execution:mac", ...labels],
      delegate: DELEGATE,
      blockedByIds: [],
    };
  }

  function writeUsageLimitLog(logRoot, name, resetOffsetMs) {
    const logDir = path.join(logRoot, name);
    fs.mkdirSync(logDir, { recursive: true });
    const resetEpochSeconds = Math.floor((Date.now() + resetOffsetMs) / 1000);
    fs.writeFileSync(path.join(logDir, "stdout.log"), `Claude usage limit reached · reset|${resetEpochSeconds}\n`);
    return logDir;
  }

  function writeCleanLog(logRoot, name) {
    const logDir = path.join(logRoot, name);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "stdout.log"), "\n");
    return logDir;
  }

  it("blocks a second same-batch claude issue after the first hits a limit, while a codex-pinned issue and a fresh worker:any issue both still progress on codex", async () => {
    const issueC1 = makeIssue({ id: "id-c1", identifier: "MOV-C1", title: "First claude issue" });
    const issueC2 = makeIssue({ id: "id-c2", identifier: "MOV-C2", title: "Second claude issue" });
    const issueCodex = makeIssue({ id: "id-cx", identifier: "MOV-CX", title: "A codex issue", labels: ["worker:codex"] });
    const issueAny = makeIssue({ id: "id-any", identifier: "MOV-ANY", title: "A flexible issue", labels: ["worker:any"] });
    const linearClient = fakeLinearClient({
      "id-c1": issueC1,
      "id-c2": issueC2,
      "id-cx": issueCodex,
      "id-any": issueAny,
    });
    const issues = [issueC1, issueC2, issueCodex, issueAny];
    const ctx = {
      ...(await buildRunContext(linearClient, TEAM_KEY, issues)),
      ...fakeLeaves({ worktreeManager: statefulWorktreeRegistry() }),
    };
    const manager = ctx.worktreeManager;

    const c1LogDir = writeUsageLimitLog(ctx.logRoot, worktreeName(issueC1.identifier, issueC1.title), 3600_000);
    const c2LogDir = writeCleanLog(ctx.logRoot, worktreeName(issueC2.identifier, issueC2.title));
    const cxLogDir = writeCleanLog(ctx.logRoot, worktreeName(issueCodex.identifier, issueCodex.title));
    const anyLogDir = writeCleanLog(ctx.logRoot, worktreeName(issueAny.identifier, issueAny.title));
    ctx.spawnWorkerFn = vi.fn(async ({ cwd }) => {
      if (cwd.includes("MOV-C1")) return { exitCode: 1, logDir: c1LogDir };
      if (cwd.includes("MOV-C2")) return { exitCode: 0, logDir: c2LogDir };
      if (cwd.includes("MOV-CX")) return { exitCode: 0, logDir: cxLogDir };
      return { exitCode: 0, logDir: anyLogDir };
    });

    const [c1Result, c2Result, cxResult, anyResult] = await runOnce(issues, ctx);

    expect(c1Result.outcome).toBe("usage-limit-deferred");
    // The whole point: MOV-C2 (same worker, same batch) is stopped before it
    // ever creates a worktree or spawns a worker -- not escalated, not
    // dispatched, no Linear write of its own.
    expect(c2Result).toMatchObject({ issue: "MOV-C2", outcome: "deferred-worker-cooldown" });
    expect(linearClient.calls.some((c) => c.issueId === "id-c2")).toBe(false);
    // Codex is a fully independent quota pool: both the pinned and the fresh
    // worker:any issue progress normally on it.
    expect(cxResult).toMatchObject({ issue: "MOV-CX", outcome: "in-review" });
    expect(anyResult).toMatchObject({ issue: "MOV-ANY", outcome: "in-review" });

    // Exact spawn/worktree counts: three real attempts (C1, CX, ANY), never
    // four -- C2 never reaches worktree creation or the worker at all.
    expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(3);
    expect(manager.createCalls.map((c) => c.id)).toEqual(["MOV-C1", "MOV-CX", "MOV-ANY"]);
    expect(manager.createCalls.find((c) => c.id === "MOV-CX").worker).toBe("codex");
    expect(manager.createCalls.find((c) => c.id === "MOV-ANY").worker).toBe("codex");

    // The cooldown this batch produced is real, persisted state -- a fresh
    // store over the same on-disk path (a restarted daemon) still sees it.
    const restarted = new WorkerCooldownStore(`${TMP_ROOT}/worker-cooldowns.json`);
    expect(restarted.state("claude", new Date()).cooling).toBe(true);
    expect(restarted.state("codex", new Date()).cooling).toBe(false);
  });

  // Acceptance: "That issue's scheduled retry or retained-worktree resume
  // uses its original worker and branch. After reset, one eligible attempt
  // for that worker is admitted first as a probe." Run as one continuous
  // sequence of real poll cycles -- deferral, a restart, the post-reset
  // probe -- against the same on-disk state, because the property worth
  // proving is that the *worker binding* survives the restart intact.
  it("keeps a worker:any issue's deferred retry bound to the worker its first attempt used, across a restart and into the post-reset probe", async () => {
    const issue = makeIssue({ id: "id-any2", identifier: "MOV-ANY2", title: "Binds to its first worker", labels: ["worker:any"] });
    const linearClient = fakeLinearClient({ "id-any2": issue });
    let ctx = {
      ...(await buildRunContext(linearClient, TEAM_KEY, [issue])),
      ...fakeLeaves({ worktreeManager: statefulWorktreeRegistry() }),
    };

    const name = worktreeName(issue.identifier, issue.title);
    const logDir = writeUsageLimitLog(ctx.logRoot, name, 3600_000);
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 1, logDir }));

    // Cycle 1: a fresh worker:any claim with no cooldown anywhere picks the
    // rubric default, Claude, and immediately hits a limit.
    const [deferred] = await runOnce([issue], ctx);
    expect(deferred.outcome).toBe("usage-limit-deferred");
    expect(ctx.usageLimitStore.get("MOV-ANY2")).toMatchObject({ worker: "claude" });
    expect(new WorkerCooldownStore(`${TMP_ROOT}/worker-cooldowns.json`).state("claude", new Date()).cooling).toBe(true);

    // Restart: brand-new store instances over the same on-disk paths, exactly
    // as buildRunContext would construct for a freshly launched daemon.
    ctx = {
      ...(await buildRunContext(linearClient, TEAM_KEY, [issue])),
      ...fakeLeaves({ worktreeManager: statefulWorktreeRegistry() }),
    };
    expect(ctx.usageLimitStore.get("MOV-ANY2").worker).toBe("claude");

    // Cycle 2, after the reset: this is the single admitted post-reset probe.
    // If the worker were silently re-picked here, it could just as easily
    // land on Codex -- the assertion below is what proves it does not.
    ctx.now = () => new Date(Date.now() + 2 * 3600_000);
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 0, logDir }));

    const [probed] = await runOnce([issue], ctx);

    expect(probed.outcome).toBe("in-review");
    expect(ctx.worktreeManager.createCalls).toEqual([expect.objectContaining({ id: "MOV-ANY2", worker: "claude" })]);
    expect(new WorkerCooldownStore(`${TMP_ROOT}/worker-cooldowns.json`).state("claude", ctx.now()).cooling).toBe(false);
  });
});

describe("Codex sandbox-report lifecycle through the real run context (MOV-299)", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("requeues a graceful Codex sandbox report and persists the host-wide breaker", async () => {
    const issue = {
      id: "id-codex-sandbox", identifier: "MOV-CODEX-SANDBOX", title: "Codex sandbox report",
      description: READY_SECTIONS, url: "https://linear.app/moviecal/issue/MOV-CODEX-SANDBOX",
      project: null, labels: ["execution:mac", "worker:codex"], delegate: DELEGATE, blockedByIds: [],
    };
    const linearClient = fakeLinearClient({ "id-codex-sandbox": issue });
    const ctx = {
      ...(await buildRunContext(linearClient, TEAM_KEY, [issue])),
      ...fakeLeaves({ auditWorkerResultFn: vi.fn(() => ({ ok: true, actions: [], violations: [] })) }),
    };
    const logDir = path.join(ctx.logRoot, worktreeName(issue.identifier, issue.title));
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "stdout.log"),
      `${JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Blocked before implementation: sandbox-exec: sandbox_apply: Operation not permitted",
        },
      })}\n`,
    );
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 0, logDir }));

    const [result] = await runOnce([issue], ctx);

    expect(result).toMatchObject({ outcome: "nested-sandbox-crash", exitCode: 0 });
    expect(linearClient.calls.filter((c) => c.type === "moveToState").at(-1)).toMatchObject({
      issueId: "id-codex-sandbox",
      stateId: "state-ready",
    });
    expect(linearClient.calls.filter((c) => c.type === "addComment").at(-1).body).toContain("sandbox_apply: Operation not permitted");
    expect(new CircuitBreakerStore(`${TMP_ROOT}/circuit-breaker.json`).isOpen(NESTED_SANDBOX_CRASH)).toBe(true);
  });
});

describe("credential-failure circuit breaker, one continuous run across two poll cycles (MOV-177)", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  /**
   * A worktree manager that tracks status the way the real WorktreeManager
   * does (activeCount() only counts "active" entries, and a same-issue
   * terminal-status worktree is reclaimed rather than blocking a requeued
   * issue's own path -- the MOV-181 reclaim behavior). Needed so cycle 2's
   * redispatch of the requeued issue behaves the way it would against the
   * real WorktreeManager: without status tracking, a plain "ever created"
   * fake either wrongly blocks the requeued issue's own path forever, or
   * wrongly frees a concurrency slot no real preflight would free.
   */
  function reclaimingWorktreeManager() {
    const entries = new Map();
    return {
      createCalls: [],
      statusCalls: [],
      activeCount: () => [...entries.values()].filter((e) => e.status === "active").length,
      isPathFree: (p) => ![...entries.values()].some((e) => e.path === p),
      isPathFreeForIssue(p, issueId) {
        const occupant = [...entries.entries()].find(([, e]) => e.path === p);
        if (!occupant) return true;
        const [occupantId, entry] = occupant;
        if (occupantId === issueId && entry.status !== "active") {
          entries.delete(occupantId);
          return true;
        }
        return false;
      },
      create(args) {
        const worktreePath = `${TMP_ROOT}/fake-worktrees/${args.name}`;
        entries.set(args.id, { path: worktreePath, status: "active" });
        this.createCalls.push(args);
        return { path: worktreePath, ...args };
      },
      markStatus(id, status, extra = {}) {
        this.statusCalls.push({ id, status, ...extra });
        entries.set(id, { ...(entries.get(id) || {}), status });
      },
    };
  }

  it("trips the persisted breaker on the first credential failure, requeues it, leaves a second eligible issue unclaimed, keeps the promote pass running, and closes on a successful probe", async () => {
    // If credential-failure.mjs's classifier or run-context.mjs's real
    // CircuitBreakerStore wiring is ever removed, `firstResult.outcome` below
    // reads "worker-failed" (escalated to Needs Human Decision) instead of
    // "credential-failure", and the breaker never persists -- this is the
    // assertion that catches both regressions at once.
    const issueA = {
      id: "id-cred-a", identifier: "MOV-CRED-A", title: "Hits a bad credential",
      description: READY_SECTIONS, url: "https://linear.app/moviecal/issue/MOV-CRED-A",
      project: null, labels: ["execution:mac"], delegate: DELEGATE, blockedByIds: [],
    };
    const issueB = {
      id: "id-cred-b", identifier: "MOV-CRED-B", title: "A second eligible issue",
      description: READY_SECTIONS, url: "https://linear.app/moviecal/issue/MOV-CRED-B",
      project: null, labels: ["execution:mac"], delegate: DELEGATE, blockedByIds: [],
    };
    const linearClient = fakeLinearClient({ "id-cred-a": issueA, "id-cred-b": issueB });
    const ctx = {
      ...(await buildRunContext(linearClient, TEAM_KEY, [issueA, issueB])),
      ...fakeLeaves({ worktreeManager: reclaimingWorktreeManager() }),
    };

    // Cycle 1: the worker never gets a session -- the provider credential is
    // rejected before any real work happens.
    const nameA = worktreeName(issueA.identifier, issueA.title);
    const logDirA = path.join(ctx.logRoot, nameA);
    fs.mkdirSync(logDirA, { recursive: true });
    fs.writeFileSync(
      path.join(logDirA, "stdout.log"),
      "401 OAuth access token has expired. Re-authenticate to continue.\n",
    );
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 1, logDir: logDirA }));

    const [firstResult] = await runOnce([issueA], ctx);

    expect(firstResult.outcome).toBe("credential-failure");
    const lastMove = linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
    expect(lastMove).toMatchObject({ issueId: "id-cred-a", stateId: "state-ready" });
    const lastComment = linearClient.calls.filter((c) => c.type === "addComment").at(-1);
    expect(lastComment.body).toContain("**Dispatcher credential is invalid or expired.**");

    // The breaker is real, persisted state (backed by the temp path
    // config.mjs is mocked to above) -- a fresh store reading the same
    // on-disk file, exactly like a restarted daemon would, sees it open.
    expect(new CircuitBreakerStore(`${TMP_ROOT}/circuit-breaker.json`).isOpen(CREDENTIAL_FAILURE)).toBe(true);

    // Regression guard: the promote pass is a completely separate call
    // (bin/dispatcher.mjs's cmdRunOnce runs it before ever touching dispatch)
    // that never consults the breaker at all -- it must keep working
    // normally while dispatch is paused, not silently no-op.
    const backlogIssue = {
      id: "id-backlog", identifier: "MOV-BACKLOG", stateName: "Backlog",
      description: READY_SECTIONS, labels: [], blockedByIds: [], inverseRelations: [], recentComments: [],
    };
    const promotion = await promoteEligible([backlogIssue], {
      linearClient,
      readyForAgentStateId: "state-ready",
      isBlockerSatisfied: buildIsIssueSatisfied([backlogIssue]),
    });
    expect(promotion).toEqual([
      { issue: "MOV-BACKLOG", promoted: true, reason: expect.any(String), specViolations: expect.any(Array) },
    ]);

    // Cycle 2: issueA (requeued) and issueB (a second, independently eligible
    // issue) are both in "Ready for Agent". The breaker is open at the start
    // of this cycle, so exactly one issue is let through as the half-open
    // probe -- and this time the worker actually runs and succeeds.
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 0, logDir: `${TMP_ROOT}/logs/clean` }));

    const [probeResult, secondResult] = await runOnce([issueA, issueB], ctx);

    expect(probeResult).toMatchObject({ issue: "MOV-CRED-A", outcome: "in-review" });
    expect(secondResult).toMatchObject({ issue: "MOV-CRED-B", outcome: "circuit-breaker-open" });
    // issueB was never claimed: no worktree, no worker, no Linear write.
    expect(ctx.worktreeManager.createCalls.map((c) => c.id)).toEqual(["MOV-CRED-A", "MOV-CRED-A"]);
    expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    expect(linearClient.calls.some((c) => c.issueId === "id-cred-b")).toBe(false);

    // The breaker closed automatically -- no human touched it.
    expect(new CircuitBreakerStore(`${TMP_ROOT}/circuit-breaker.json`).isOpen(CREDENTIAL_FAILURE)).toBe(false);
  });
});

describe("advisory diagnosis for the unrecognized-failure escalation, through the real buildRunContext wiring (MOV-179)", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    diagnoseUnrecognizedFailureMock.mockReset();
  });

  function unrecognizedFailureIssue(id) {
    return {
      id: `id-${id}`, identifier: id, title: "Hits an unrecognized failure",
      description: READY_SECTIONS, url: `https://linear.app/moviecal/issue/${id}`,
      project: null, labels: ["execution:mac"], delegate: DELEGATE, blockedByIds: [],
    };
  }

  it("emits the diagnostic comment exactly once when the fake adapter succeeds, through the real ctx.diagnoseFailureFn wiring", async () => {
    const issue = unrecognizedFailureIssue("MOV-DIAG-A");
    const linearClient = fakeLinearClient({ "id-MOV-DIAG-A": issue });
    const ctx = { ...(await buildRunContext(linearClient, TEAM_KEY, [issue])), ...fakeLeaves() };

    // If run-context.mjs's `diagnoseFailureFn: diagnoseUnrecognizedFailure`
    // wiring line is ever removed, ctx.diagnoseFailureFn falls back to
    // run-loop.mjs's own NO_DIAGNOSIS default, this mock is never invoked,
    // and the assertions below on the emitted comment fail.
    diagnoseUnrecognizedFailureMock.mockResolvedValue({
      ok: true,
      confident: true,
      diagnosis: "The worker crashed with an unhandled exception before producing any output.",
      evidence: "TypeError: boom",
    });

    const name = worktreeName(issue.identifier, issue.title);
    const logDir = path.join(ctx.logRoot, name);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "stdout.log"), "TypeError: boom\n");
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 1, logDir }));

    const [result] = await runOnce([issue], ctx);

    expect(result.outcome).toBe("worker-failed");
    expect(diagnoseUnrecognizedFailureMock).toHaveBeenCalledTimes(1);
    const lastMove = linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
    expect(lastMove).toMatchObject({ issueId: "id-MOV-DIAG-A", stateId: "state-needs-human" });
    const lastComment = linearClient.calls.filter((c) => c.type === "addComment").at(-1);
    expect(lastComment.body).toContain("Diagnosis (advisory, not verified)");
    expect(lastComment.body).toContain("unhandled exception");
  });

  it("still escalates with the plain comment, unblocked, when the real-wired adapter fails", async () => {
    const issue = unrecognizedFailureIssue("MOV-DIAG-B");
    const linearClient = fakeLinearClient({ "id-MOV-DIAG-B": issue });
    const ctx = { ...(await buildRunContext(linearClient, TEAM_KEY, [issue])), ...fakeLeaves() };

    diagnoseUnrecognizedFailureMock.mockRejectedValue(new Error("diagnosis call timed out"));

    const name = worktreeName(issue.identifier, issue.title);
    const logDir = path.join(ctx.logRoot, name);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "stdout.log"), "TypeError: boom\n");
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 1, logDir }));

    const [result] = await runOnce([issue], ctx);

    expect(result.outcome).toBe("worker-failed");
    expect(diagnoseUnrecognizedFailureMock).toHaveBeenCalledTimes(1);
    const lastMove = linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
    expect(lastMove).toMatchObject({ issueId: "id-MOV-DIAG-B", stateId: "state-needs-human" });
    const lastComment = linearClient.calls.filter((c) => c.type === "addComment").at(-1);
    expect(lastComment.body).not.toContain("Diagnosis");
    expect(lastComment.body).toContain("TypeError: boom");
  });

  it("never invokes the real-wired adapter for a credential-failure signature, an already-classified path", async () => {
    const issue = unrecognizedFailureIssue("MOV-DIAG-C");
    const linearClient = fakeLinearClient({ "id-MOV-DIAG-C": issue });
    const ctx = { ...(await buildRunContext(linearClient, TEAM_KEY, [issue])), ...fakeLeaves() };

    diagnoseUnrecognizedFailureMock.mockResolvedValue({ ok: true, confident: true, diagnosis: "should never be seen" });

    const name = worktreeName(issue.identifier, issue.title);
    const logDir = path.join(ctx.logRoot, name);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "stdout.log"), "401 OAuth access token has expired. Re-authenticate to continue.\n");
    ctx.spawnWorkerFn = vi.fn(async () => ({ exitCode: 1, logDir }));

    const [result] = await runOnce([issue], ctx);

    expect(result.outcome).toBe("credential-failure");
    expect(diagnoseUnrecognizedFailureMock).not.toHaveBeenCalled();
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

// MOV-308. The promoter and the audit pass run back-to-back in every poll
// cycle, against the same issues, writing comments to the same Linear issue.
// Their unit tests each use their own isolated fake, which is exactly the gap
// this block closes: the audit's "don't repeat yourself" rule depends on
// reading comment bodies back, and the promoter is writing its own comments
// into that same stream in between. Nothing short of running both against one
// client, across cycles, proves that still works.
describe("promotion -> issue-completeness audit, one continuous run (MOV-308)", () => {
  const AUDIT_LABELS = ["execution:mac", "type:fix", "worker:any", "model:default", "area:process"];

  /** A Backlog issue that is *promotable* but not *complete*: no risk label, no project. */
  function incompleteButReady(overrides = {}) {
    return {
      id: "id-audit-e2e",
      identifier: "MOV-AUDIT",
      title: "Ready to promote, not fully specced",
      stateName: "Backlog",
      description: READY_SECTIONS,
      labels: [...AUDIT_LABELS],
      project: null,
      projectStatus: null,
      projectMilestoneCount: 0,
      milestone: null,
      blockedByIds: [],
      inverseRelations: [],
      recentComments: [],
      ...overrides,
    };
  }

  /** Every comment body written to `issueId` so far, oldest-to-newest — the
   *  same thing `issuesForSpecAudit`'s `recentComments` hands the next pass. */
  function commentsSoFar(linearClient, issueId) {
    return linearClient.calls.filter((c) => c.type === "addComment" && c.issueId === issueId).map((c) => c.body);
  }

  /** One poll cycle: the real promoter, then the real audit, one client. */
  async function pollCycle(linearClient, issue, { issueSpecMode }) {
    const promotion = await promoteEligible([issue], {
      linearClient,
      readyForAgentStateId: "state-ready",
      isBlockerSatisfied: buildIsIssueSatisfied([issue]),
      issueSpecMode,
    });
    const audit = await auditIssueSpecs(
      [{ ...issue, recentComments: commentsSoFar(linearClient, issue.id) }],
      { linearClient },
    );
    return { promotion: promotion[0], audit: audit[0] };
  }

  it("promotes in report mode, comments once on the same issue, then stays silent for the rest of the run", async () => {
    const linearClient = fakeLinearClient();
    const issue = incompleteButReady();

    const first = await pollCycle(linearClient, issue, { issueSpecMode: "report" });

    // `report` mode: it still promotes, and the audit is what surfaces the gap.
    expect(first.promotion).toMatchObject({ issue: "MOV-AUDIT", promoted: true });
    expect(first.audit.action).toBe("commented");
    expect(linearClient.calls).toEqual([
      { type: "moveToState", issueId: "id-audit-e2e", stateId: "state-ready" },
      { type: "addComment", issueId: "id-audit-e2e", body: PROMOTION_COMMENT },
      { type: "addComment", issueId: "id-audit-e2e", body: expect.stringContaining(AUDIT_COMMENT_HEADLINE) },
    ]);
    const auditBody = linearClient.calls[2].body;
    expect(auditBody).toContain("no `risk:*` label");
    expect(auditBody).toContain("no project");

    // Cycle two: the issue has left Backlog (so the promoter skips it), and
    // the audit reads back its own marker past the promoter's comment and
    // writes nothing. This is the shape that would otherwise bury a live issue
    // under one identical comment every 30 seconds.
    const promoted = { ...issue, stateName: "Ready for Agent" };
    const second = await pollCycle(linearClient, promoted, { issueSpecMode: "report" });
    expect(second.promotion).toBeUndefined();
    expect(second.audit.action).toBe("unchanged");
    expect(linearClient.calls).toHaveLength(3);

    // Cycle three: a human adds the risk label but no project. One new comment,
    // naming only what is still missing.
    const partlyFixed = { ...promoted, labels: [...AUDIT_LABELS, "risk:low"] };
    const third = await pollCycle(linearClient, partlyFixed, { issueSpecMode: "report" });
    expect(third.audit.action).toBe("updated");
    expect(linearClient.calls).toHaveLength(4);
    expect(linearClient.calls[3].body).toContain("no project");
    expect(linearClient.calls[3].body).not.toContain("no `risk:*` label");

    // Cycle four: the project is assigned. The issue goes quiet — no comment,
    // and deliberately no "resolved" comment either.
    const fixed = { ...partlyFixed, project: "Autonomous local-agent delivery", projectStatus: "started" };
    const fourth = await pollCycle(linearClient, fixed, { issueSpecMode: "report" });
    expect(fourth.audit.action).toBe("compliant");
    expect(linearClient.calls).toHaveLength(4);
  });

  it("withholds promotion in enforce mode while the audit comments exactly as it does in report mode", async () => {
    const reportClient = fakeLinearClient();
    const enforceClient = fakeLinearClient();
    const issue = incompleteButReady();

    const report = await pollCycle(reportClient, issue, { issueSpecMode: "report" });
    const enforce = await pollCycle(enforceClient, issue, { issueSpecMode: "enforce" });

    // The promoter is the half that changes with the mode.
    expect(report.promotion.promoted).toBe(true);
    expect(enforce.promotion).toMatchObject({
      promoted: false,
      reason: expect.stringContaining("incomplete issue spec (MOV-303)"),
    });
    expect(enforceClient.calls.some((c) => c.type === "moveToState")).toBe(false);

    // The audit is not: commenting is everything it can do, so `enforce` and
    // `report` produce byte-identical output. A difference here would mean it
    // had quietly grown a second behaviour to keep in step with the promoter.
    const auditBody = (client) =>
      client.calls.find((c) => c.type === "addComment" && c.body.includes(AUDIT_COMMENT_HEADLINE)).body;
    expect(report.audit.action).toBe("commented");
    expect(enforce.audit.action).toBe("commented");
    expect(auditBody(enforceClient)).toBe(auditBody(reportClient));

    // And in enforce mode the audit is still the only thing that wrote at all.
    expect(enforceClient.calls).toEqual([
      { type: "addComment", issueId: "id-audit-e2e", body: expect.stringContaining(AUDIT_COMMENT_HEADLINE) },
    ]);

    // Repeat the enforce cycle: the promoter keeps refusing, the audit keeps quiet.
    const again = await pollCycle(enforceClient, issue, { issueSpecMode: "enforce" });
    expect(again.promotion.promoted).toBe(false);
    expect(again.audit.action).toBe("unchanged");
    expect(enforceClient.calls).toHaveLength(1);
  });

  it("audits the states the promoter never looks at, and never writes anything but a comment", async () => {
    const linearClient = fakeLinearClient();
    // Exactly the cohort MOV-308 exists for: none of these is in Backlog or
    // Blocked, so promoteEligible never evaluates any of them.
    const issues = [
      incompleteButReady({ id: "id-spec-ready", identifier: "MOV-SR", stateName: "Spec Ready" }),
      incompleteButReady({ id: "id-icebox", identifier: "MOV-ICE", stateName: "Icebox" }),
      incompleteButReady({ id: "id-working", identifier: "MOV-WORK", stateName: "Agent Working" }),
      incompleteButReady({
        id: "id-human",
        identifier: "MOV-HUMAN",
        stateName: "Spec Ready",
        labels: ["human-only", "type:chore", "risk:low", "area:process"],
      }),
      incompleteButReady({ id: "id-triage", identifier: "MOV-TRIAGE", stateName: "Triage", labels: [] }),
    ];

    const promotion = await promoteEligible(issues, {
      linearClient,
      readyForAgentStateId: "state-ready",
      isBlockerSatisfied: buildIsIssueSatisfied(issues),
      issueSpecMode: "report",
    });
    expect(promotion.every((r) => !r.promoted)).toBe(true);
    expect(linearClient.calls).toEqual([]);

    const audit = await auditIssueSpecs(issues, { linearClient });

    expect(audit.map((r) => r.action)).toEqual(["commented", "commented", "commented", "commented", "exempt"]);
    expect(linearClient.calls.map((c) => c.type)).toEqual(Array(4).fill("addComment"));
    expect(linearClient.calls.map((c) => c.issueId)).toEqual([
      "id-spec-ready",
      "id-icebox",
      "id-working",
      "id-human",
    ]);
  });
});
