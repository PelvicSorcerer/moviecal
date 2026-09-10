import { describe, it, expect, vi } from "vitest";
import { runOnce } from "../src/run-loop.mjs";
import { buildIsIssueSatisfied } from "../src/dependency-gate.mjs";

const STATE_IDS = {
  blocked: "state-blocked",
  agentWorking: "state-agent-working",
  needsHumanDecision: "state-needs-human",
  inReview: "state-in-review",
};

function fakeLinearClient() {
  return {
    calls: [],
    moveToState: vi.fn(async function (issueId, stateId) {
      this.calls.push({ type: "moveToState", issueId, stateId });
    }),
    addComment: vi.fn(async function (issueId, body) {
      this.calls.push({ type: "addComment", issueId, body });
    }),
  };
}

function fakeWorktreeManager({ activeCount = 0, pathFree = true } = {}) {
  return {
    createCalls: [],
    statusCalls: [],
    activeCount: () => activeCount,
    isPathFree: () => pathFree,
    create(args) {
      this.createCalls.push(args);
      return { path: `/fake/worktrees/${args.name}`, ...args };
    },
    markStatus(id, status, extra = {}) {
      this.statusCalls.push({ id, status, ...extra });
    },
  };
}

/**
 * A worktree manager that actually tracks taken paths, so a second pass over
 * the same issue collides the way the real one does (MOV-143 idempotency).
 */
function statefulWorktreeManager() {
  const taken = new Set();
  return {
    createCalls: [],
    statusCalls: [],
    activeCount: () => taken.size,
    isPathFree: (p) => !taken.has(p),
    create(args) {
      const path = `/fake/worktrees/${args.name}`;
      taken.add(path);
      this.createCalls.push(args);
      return { path, ...args };
    },
    markStatus(id, status, extra = {}) {
      this.statusCalls.push({ id, status, ...extra });
    },
  };
}

function baseCtx(overrides = {}) {
  const linearClient = fakeLinearClient();
  const worktreeManager = fakeWorktreeManager();
  return {
    linearClient,
    stateIds: STATE_IDS,
    worktreeManager,
    dispatcherDelegate: DISPATCHER_DELEGATE,
    concurrencyLimit: 2,
    workerTimeoutMs: 2_700_000,
    iosRunnerOnline: true,
    secretPresent: () => true,
    worktreeRoot: "/fake/worktrees",
    envLocalSource: undefined,
    ghRepo: "owner/repo",
    logRoot: "/fake/logs",
    spawnWorkerFn: vi.fn(async () => ({ exitCode: 0, logDir: "/fake/logs/x" })),
    findPrForBranchFn: vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true, headSha: "sha-1" })),
    auditWorkerResultFn: vi.fn(() => ({ ok: true, violations: [] })),
    writeWorkerAuditFn: vi.fn(() => ({ path: "/fake/logs/x/security-audit.json", sha256: "abc123" })),
    ...overrides,
  };
}

/** A worker fake that stays pending until the test resolves it, recording start/end for overlap assertions. */
function deferredSpawnWorkerFn() {
  const windows = [];
  const controls = [];
  const fn = vi.fn(() => {
    const window = { start: windows.length, end: null };
    windows.push(window);
    let resolve;
    const p = new Promise((res) => {
      resolve = () => {
        window.end = "resolved";
        res({ exitCode: 0, logDir: "/fake/logs/x" });
      };
    });
    controls.push(resolve);
    return p;
  });
  return { fn, windows, controls };
}

/** Flush pending microtasks so in-flight promise chains settle before assertions. */
async function flushMicrotasks() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

// MOV-143: the dispatcher claims an issue only when it is routed to this
// adapter AND delegated to it, so every fixture that is *meant* to dispatch
// carries both. Tests that add a label must keep `execution:mac` — dropping it
// changes what is being tested from "unready" to "not ours".
const DISPATCHER_DELEGATE = { id: "actor-dispatcher", name: "moviecal-dispatcher" };

const ISSUE = {
  id: "id-1",
  identifier: "MOV-1",
  title: "Fix the thing",
  description: "Do the fix.",
  url: "https://linear.app/moviecal/issue/MOV-1",
  project: null,
  labels: ["execution:mac"],
  delegate: { id: "actor-dispatcher", name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" },
  blockedByIds: [],
};

describe("runOnce", () => {
  it("moves a human-only issue to blocked without touching the worktree manager", async () => {
    const ctx = baseCtx();
    const issue = { ...ISSUE, labels: [...ISSUE.labels, "human-only"] };

    const [result] = await runOnce([issue], ctx);

    expect(result.outcome).toBe("blocked");
    expect(ctx.linearClient.calls).toEqual([
      { type: "moveToState", issueId: "id-1", stateId: "state-blocked" },
      { type: "addComment", issueId: "id-1", body: expect.stringContaining("human-only") },
    ]);
    expect(ctx.worktreeManager.createCalls).toHaveLength(0);
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
  });

  it("moves an issue with an uncited model:strong to needs-human without spawning a worker", async () => {
    const ctx = baseCtx();
    const issue = { ...ISSUE, labels: [...ISSUE.labels, "model:strong"] };

    const [result] = await runOnce([issue], ctx);

    expect(result.outcome).toBe("needs-human");
    expect(ctx.linearClient.calls[0]).toEqual({
      type: "moveToState",
      issueId: "id-1",
      stateId: "state-needs-human",
    });
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
  });

  it("runs the full happy path: worktree created, agent-working reported, PR found, in-review reported", async () => {
    const ctx = baseCtx();

    const [result] = await runOnce([ISSUE], ctx);

    expect(ctx.worktreeManager.createCalls).toHaveLength(1);
    expect(ctx.worktreeManager.createCalls[0]).toMatchObject({ id: "MOV-1", worker: "claude", linearIssueId: "id-1" });

    const stateChanges = ctx.linearClient.calls.filter((c) => c.type === "moveToState").map((c) => c.stateId);
    expect(stateChanges).toEqual(["state-agent-working", "state-in-review"]);

    expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    const spawnArg = ctx.spawnWorkerFn.mock.calls[0][0];
    expect(spawnArg.cwd).toBe("/fake/worktrees/MOV-1-fix-the-thing");
    expect(spawnArg.brief).toContain("MOV-1");
    expect(spawnArg.securityContext).toEqual({ mode: "implementation" });

    expect(ctx.worktreeManager.statusCalls).toEqual([
      { id: "MOV-1", status: "review", prNumber: 1, prUrl: "https://github.com/owner/repo/pull/1", headSha: "sha-1" },
    ]);
    expect(result).toEqual({ issue: "MOV-1", outcome: "in-review", pr: "https://github.com/owner/repo/pull/1" });
  });

  it("does not call applyStagedWorkflowEditFn for an ordinary (unauthorized) issue", async () => {
    const applyStagedWorkflowEditFn = vi.fn(() => ({ applied: false, reason: "not configured" }));
    const ctx = baseCtx({ applyStagedWorkflowEditFn });

    await runOnce([ISSUE], ctx);

    expect(applyStagedWorkflowEditFn).not.toHaveBeenCalled();
  });

  it("applies a staged workflow-edit proposal and comments when the issue is authorized", async () => {
    const applyStagedWorkflowEditFn = vi.fn(() => ({ applied: true, path: ".github/workflows/ios-verify.yml" }));
    const ctx = baseCtx({ applyStagedWorkflowEditFn });
    const issue = {
      ...ISSUE,
      labels: [...ISSUE.labels, "ci:workflow-edit-authorized"],
      description: "Workflow-edit: .github/workflows/ios-verify.yml",
    };

    await runOnce([issue], ctx);

    expect(applyStagedWorkflowEditFn).toHaveBeenCalledWith(
      "/fake/worktrees/MOV-1-fix-the-thing",
      ".github/workflows/ios-verify.yml",
    );
    const comments = ctx.linearClient.calls.filter((c) => c.type === "addComment").map((c) => c.body);
    expect(comments.some((b) => b.includes("Applied staged workflow-edit proposal"))).toBe(true);
  });

  it("does not comment when authorized but the worker staged nothing", async () => {
    const applyStagedWorkflowEditFn = vi.fn(() => ({ applied: false, reason: "no staged proposal found" }));
    const ctx = baseCtx({ applyStagedWorkflowEditFn });
    const issue = {
      ...ISSUE,
      labels: [...ISSUE.labels, "ci:workflow-edit-authorized"],
      description: "Workflow-edit: .github/workflows/ios-verify.yml",
    };

    await runOnce([issue], ctx);

    expect(applyStagedWorkflowEditFn).toHaveBeenCalled();
    const comments = ctx.linearClient.calls.filter((c) => c.type === "addComment").map((c) => c.body);
    expect(comments.some((b) => b.includes("Applied staged workflow-edit proposal"))).toBe(false);
  });

  it("never applies a staged workflow proposal during repair", async () => {
    const applyStagedWorkflowEditFn = vi.fn(() => ({ applied: true }));
    const ctx = baseCtx({ applyStagedWorkflowEditFn, workerMode: "repair" });
    const issue = {
      ...ISSUE,
      labels: [...ISSUE.labels, "ci:workflow-edit-authorized"],
      description: "Workflow-edit: .github/workflows/ios-verify.yml",
    };

    await runOnce([issue], ctx);

    expect(applyStagedWorkflowEditFn).not.toHaveBeenCalled();
    expect(ctx.spawnWorkerFn.mock.calls[0][0].securityContext).toEqual({ mode: "repair" });
  });

  it("fails closed with an audit record before workflow apply or publication on a bypass attempt", async () => {
    const applyStagedWorkflowEditFn = vi.fn();
    const publishWorkerResultFn = vi.fn();
    const ctx = baseCtx({
      applyStagedWorkflowEditFn,
      publishWorkerResultFn,
      auditWorkerResultFn: vi.fn(() => ({
        ok: false,
        violations: [{ action: "gh api -X DELETE repos/o/r/rulesets/1", reason: "direct GitHub API access" }],
      })),
    });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("security-blocked");
    expect(applyStagedWorkflowEditFn).not.toHaveBeenCalled();
    expect(publishWorkerResultFn).not.toHaveBeenCalled();
    expect(ctx.findPrForBranchFn).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
    expect(ctx.linearClient.calls.at(-1).body).toContain("Worker safety boundary blocked publication");
    expect(ctx.linearClient.calls.at(-1).body).toContain("SHA-256");
  });

  it("publishes only through the trusted dispatcher callback after a clean audit", async () => {
    const publishWorkerResultFn = vi.fn(() => ({
      number: 4,
      url: "https://github.com/owner/repo/pull/4",
      isDraft: true,
      headSha: "sha-4",
    }));
    const ctx = baseCtx({ publishWorkerResultFn });

    const [result] = await runOnce([ISSUE], ctx);

    expect(publishWorkerResultFn).toHaveBeenCalledWith({
      worktreePath: "/fake/worktrees/MOV-1-fix-the-thing",
      branch: "agent/MOV-1-fix-the-thing",
      repo: "owner/repo",
      issue: ISSUE,
    });
    expect(ctx.findPrForBranchFn).not.toHaveBeenCalled();
    expect(result.pr).toBe("https://github.com/owner/repo/pull/4");
  });

  it("marks the worktree failed and reports needs-human-decision with log tail when the worker exits non-zero", async () => {
    const ctx = baseCtx({ spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir: "/fake/logs/MOV-1" })) });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("worker-failed");
    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
    const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
    expect(lastMove.stateId).toBe("state-needs-human");
    expect(ctx.findPrForBranchFn).not.toHaveBeenCalled();
  });

  it("marks failed and reports needs-human-decision when the worker exits 0, opens no PR, and the worktree is clean", async () => {
    const ctx = baseCtx({
      findPrForBranchFn: vi.fn(() => null),
      uncommittedChangesFn: vi.fn(() => []),
    });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("no-pr");
    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
    const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
    expect(lastComment.body).toMatch(/found no PR/);
  });

  it("defaults to no-pr when uncommittedChangesFn is not provided (existing callers unaffected)", async () => {
    const ctx = baseCtx({ findPrForBranchFn: vi.fn(() => null) });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("no-pr");
  });

  it("reports abandoned-dirty (MOV-137) when the worker exits 0 with uncommitted changes and no PR", async () => {
    const uncommittedChangesFn = vi.fn(() => ["src/Auth.swift", "src/AuthTests.swift"]);
    const ctx = baseCtx({
      findPrForBranchFn: vi.fn(() => null),
      uncommittedChangesFn,
    });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("abandoned-dirty");
    expect(result.uncommittedPaths).toEqual(["src/Auth.swift", "src/AuthTests.swift"]);
    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
    expect(uncommittedChangesFn).toHaveBeenCalledWith("/fake/worktrees/MOV-1-fix-the-thing");

    const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
    expect(lastMove.stateId).toBe("state-needs-human");

    const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
    expect(lastComment.body).toMatch(/unpublished changes after the trusted publication step/);
    expect(lastComment.body).toContain("src/Auth.swift");
    expect(lastComment.body).toContain("src/AuthTests.swift");
  });

  it("does not report abandoned-dirty when a PR was opened, even if uncommittedChangesFn would report dirty (unreachable in practice)", async () => {
    const uncommittedChangesFn = vi.fn(() => ["src/Auth.swift"]);
    const ctx = baseCtx({ uncommittedChangesFn });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("in-review");
    expect(uncommittedChangesFn).not.toHaveBeenCalled();
  });

  it("marks failed and reports needs-human-decision when spawning the worker itself throws", async () => {
    const ctx = baseCtx({
      spawnWorkerFn: vi.fn(async () => {
        throw new Error("ENOENT: claude not found");
      }),
    });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("spawn-error");
    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
    expect(ctx.writeWorkerAuditFn).toHaveBeenCalledWith("/fake/logs/MOV-1-fix-the-thing", expect.objectContaining({
      issue: "MOV-1",
      phase: "spawn",
      ok: false,
      violations: [expect.objectContaining({ reason: expect.stringContaining("ENOENT") })],
    }));
    expect(ctx.linearClient.calls.at(-1).body).toContain("ENOENT");
    expect(ctx.linearClient.calls.at(-1).body).toContain("SHA-256");
    expect(ctx.linearClient.calls.at(-1).body).toContain("no worker ran and no remote mutation was attempted");
  });

  it("blocks on the concurrency limit before creating a worktree", async () => {
    const ctx = baseCtx({ worktreeManager: fakeWorktreeManager({ activeCount: 2 }) });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toMatch(/concurrency/);
    expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
  });

  it("processes multiple issues independently in one pass", async () => {
    const ctx = baseCtx();
    const issueA = { ...ISSUE, id: "id-a", identifier: "MOV-a" };
    const issueB = { ...ISSUE, id: "id-b", identifier: "MOV-b", labels: [...ISSUE.labels, "human-only"] };

    const results = await runOnce([issueA, issueB], ctx);

    expect(results.map((r) => r.outcome)).toEqual(["in-review", "blocked"]);
  });

  describe("real dependency gating via buildIsIssueSatisfied (MOV-128)", () => {
    // Mirrors LinearClient normalization: each issue's own blockedByIds/
    // inverseRelations, as buildRunContext would receive them from a live
    // issuesInState() batch.
    function issueBlockedBy(blockerId, blockerStateName) {
      return {
        ...ISSUE,
        blockedByIds: [blockerId],
        // Real Linear shape: `issue` is the blocker, `relatedIssue` is self.
        inverseRelations: [
          { type: "blocks", issue: { id: blockerId, state: { name: blockerStateName } }, relatedIssue: { id: ISSUE.id } },
        ],
      };
    }

    it("blocks and does not dispatch when the blocker is still In Review", async () => {
      const issue = issueBlockedBy("id-125", "In Review");
      const ctx = baseCtx({ isIssueSatisfied: buildIsIssueSatisfied([issue]) });

      const [result] = await runOnce([issue], ctx);

      expect(result.outcome).toBe("blocked");
      expect(result.reason).toMatch(/blocked by unresolved relation\(s\): id-125/);
      expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    });

    it("blocks and does not dispatch when the blocker is still in Backlog", async () => {
      const issue = issueBlockedBy("id-125", "Backlog");
      const ctx = baseCtx({ isIssueSatisfied: buildIsIssueSatisfied([issue]) });

      const [result] = await runOnce([issue], ctx);

      expect(result.outcome).toBe("blocked");
      expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    });

    it("proceeds once the blocker reaches Done", async () => {
      const issue = issueBlockedBy("id-125", "Done");
      const ctx = baseCtx({ isIssueSatisfied: buildIsIssueSatisfied([issue]) });

      const [result] = await runOnce([issue], ctx);

      expect(result.outcome).toBe("in-review");
      expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("route + delegation gate (MOV-143)", () => {
    /** Every way an issue can fail to be this dispatcher's to claim, and stay untouched. */
    const notOurs = [
      ["cloud-routed", { project: "Calendar Feed", labels: ["execution:cloud"] }],
      ["coordination-only", { labels: ["type:coordination", "execution:none"] }],
      ["delegated to a human", { delegate: { id: "user-adam", name: "Adam", displayName: "Adam" } }],
      ["not delegated at all", { delegate: null }],
      ["cloud-routed AND delegated elsewhere", { project: "Calendar Feed", labels: ["execution:cloud"], delegate: null }],
    ];

    it.each(notOurs)("skips a %s issue with no worktree, no worker, and no Linear write", async (_label, patch) => {
      const ctx = baseCtx();
      const issue = { ...ISSUE, ...patch };

      const [result] = await runOnce([issue], ctx);

      expect(result.outcome).toBe("not-eligible");
      expect(ctx.worktreeManager.createCalls).toHaveLength(0);
      expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
      // The whole point: the dispatcher is not this issue's writer.
      expect(ctx.linearClient.calls).toEqual([]);
    });

    it("keeps a correctly Mac-routed, correctly delegated issue eligible", async () => {
      const ctx = baseCtx();

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    });

    it("escalates an un-routed issue that is delegated here, then never sees it again", async () => {
      const ctx = baseCtx();
      const issue = { ...ISSUE, labels: [] };

      const [result] = await runOnce([issue], ctx);

      expect(result.outcome).toBe("needs-human");
      expect(result.reason).toMatch(/missing execution label/);
      expect(ctx.linearClient.calls[0]).toEqual({
        type: "moveToState",
        issueId: "id-1",
        stateId: "state-needs-human",
      });
      expect(ctx.linearClient.calls[1].body).toMatch(/execution:mac/);
      expect(ctx.worktreeManager.createCalls).toHaveLength(0);
      expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    });

    it("escalates conflicting execution labels instead of picking one", async () => {
      const ctx = baseCtx();
      const issue = { ...ISSUE, labels: ["execution:mac", "execution:cloud"] };

      const [result] = await runOnce([issue], ctx);

      expect(result.outcome).toBe("needs-human");
      expect(result.reason).toMatch(/multiple execution labels/);
      expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    });

    it("does not escalate an un-routed issue delegated elsewhere — not its writer", async () => {
      const ctx = baseCtx();
      const issue = { ...ISSUE, labels: [], delegate: { id: "user-adam", name: "Adam" } };

      const [result] = await runOnce([issue], ctx);

      expect(result.outcome).toBe("not-eligible");
      expect(ctx.linearClient.calls).toEqual([]);
    });

    describe("re-check immediately before the worker starts", () => {
      /** The dispatcher re-reads the issue; the test decides what it now looks like. */
      function ctxWithRefresh(freshIssue) {
        const refreshIssueFn = vi.fn(async () => freshIssue);
        return { ctx: baseCtx({ refreshIssueFn }), refreshIssueFn };
      }

      it("no-ops when the delegate was removed after the poll snapshot", async () => {
        const { ctx, refreshIssueFn } = ctxWithRefresh({ ...ISSUE, stateName: "Ready for Agent", delegate: null });

        const [result] = await runOnce([ISSUE], ctx);

        expect(refreshIssueFn).toHaveBeenCalledTimes(1);
        expect(result.outcome).toBe("not-eligible");
        expect(result.reason).toMatch(/delegated to nobody, not moviecal-dispatcher/);
        expect(ctx.worktreeManager.createCalls).toHaveLength(0);
        expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
        expect(ctx.linearClient.calls).toEqual([]);
      });

      it("no-ops when the route was removed after the poll snapshot", async () => {
        const { ctx } = ctxWithRefresh({ ...ISSUE, stateName: "Ready for Agent", labels: [] });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("not-eligible");
        expect(ctx.worktreeManager.createCalls).toHaveLength(0);
        expect(ctx.linearClient.calls).toEqual([]);
      });

      it("no-ops when the route flipped to cloud after the poll snapshot", async () => {
        const { ctx } = ctxWithRefresh({
          ...ISSUE,
          stateName: "Ready for Agent",
          project: "Calendar Feed",
          labels: ["execution:cloud"],
        });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("not-eligible");
        expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
      });

      it("no-ops when someone else already moved the issue out of Ready for Agent", async () => {
        const { ctx } = ctxWithRefresh({ ...ISSUE, stateName: "Agent Working" });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("not-eligible");
        expect(result.reason).toMatch(/moved to "Agent Working"/);
        expect(ctx.linearClient.calls).toEqual([]);
      });

      it("no-ops when the issue is no longer readable at all", async () => {
        const { ctx } = ctxWithRefresh(null);

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("not-eligible");
        expect(ctx.worktreeManager.createCalls).toHaveLength(0);
      });

      it("fails closed on a re-read error, without aborting the rest of the batch", async () => {
        const healthy = { ...ISSUE, id: "id-ok", identifier: "MOV-ok" };
        const refreshIssueFn = vi.fn(async (issue) => {
          if (issue.identifier === "MOV-1") throw new Error("Linear API error: rate limited");
          return { ...issue, stateName: "Ready for Agent" };
        });
        const ctx = baseCtx({ refreshIssueFn, worktreeManager: statefulWorktreeManager() });

        const results = await runOnce([ISSUE, healthy], ctx);

        expect(results.find((r) => r.issue === "MOV-1")).toMatchObject({
          outcome: "not-eligible",
          reason: expect.stringMatching(/could not re-read the issue.*rate limited/),
        });
        expect(results.find((r) => r.issue === "MOV-ok").outcome).toBe("in-review");
        expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
      });

      it("re-checks before the worktree exists, not after — the state move is a report, not a lock", async () => {
        const { ctx, refreshIssueFn } = ctxWithRefresh({ ...ISSUE, stateName: "Ready for Agent" });

        await runOnce([ISSUE], ctx);

        // A claim that has to be undone is not a no-op; nothing may be created
        // or announced until the re-read has confirmed the issue is still ours.
        const firstWrite = ctx.linearClient.calls[0];
        expect(refreshIssueFn).toHaveBeenCalledTimes(1);
        expect(firstWrite).toEqual({ type: "moveToState", issueId: "id-1", stateId: "state-agent-working" });
      });
    });

    describe("duplicate poll cycles over the same snapshot", () => {
      it("dispatches once — the second cycle collides on the worktree path, it does not re-spawn", async () => {
        const ctx = baseCtx({ worktreeManager: statefulWorktreeManager() });

        const [first] = await runOnce([ISSUE], ctx);
        const [second] = await runOnce([ISSUE], ctx);

        expect(first.outcome).toBe("in-review");
        expect(second.outcome).toBe("blocked");
        expect(second.reason).toMatch(/worktree path already in use/);
        expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
        expect(ctx.worktreeManager.createCalls).toHaveLength(1);
      });

      it("stays a no-op across repeated cycles for an ineligible issue — no comment spam", async () => {
        const ctx = baseCtx({ worktreeManager: statefulWorktreeManager() });
        const issue = { ...ISSUE, project: "Calendar Feed", labels: ["execution:cloud"] };

        const outcomes = [];
        for (let cycle = 0; cycle < 3; cycle += 1) {
          outcomes.push((await runOnce([issue], ctx))[0].outcome);
        }

        expect(outcomes).toEqual(["not-eligible", "not-eligible", "not-eligible"]);
        expect(ctx.linearClient.calls).toEqual([]);
        expect(ctx.worktreeManager.createCalls).toHaveLength(0);
      });

      it("escalates an unroutable issue at most once per cycle, with identical output each time", async () => {
        const ctx = baseCtx({ worktreeManager: statefulWorktreeManager() });
        const issue = { ...ISSUE, labels: [] };

        const [first] = await runOnce([issue], ctx);
        const callsAfterFirst = ctx.linearClient.calls.length;
        const [second] = await runOnce([issue], ctx);

        // In production the escalation moves it out of "Ready for Agent", so a
        // second cycle never sees it. If it somehow does, the decision is the
        // same one and nothing has been half-claimed in between.
        expect(second).toEqual(first);
        expect(ctx.linearClient.calls.length).toBe(callsAfterFirst * 2);
        expect(ctx.worktreeManager.createCalls).toHaveLength(0);
      });
    });
  });

  describe("parallel dispatch and per-worker timeout (MOV-138)", () => {
    it("dispatches up to concurrencyLimit workers concurrently, and a third waits for a slot to free", async () => {
      const { fn: spawnWorkerFn, controls } = deferredSpawnWorkerFn();
      const issues = [
        { ...ISSUE, id: "id-a", identifier: "MOV-a" },
        { ...ISSUE, id: "id-b", identifier: "MOV-b" },
        { ...ISSUE, id: "id-c", identifier: "MOV-c" },
      ];
      const ctx = baseCtx({ spawnWorkerFn, concurrencyLimit: 2 });

      const runPromise = runOnce(issues, ctx);
      await flushMicrotasks();

      expect(spawnWorkerFn).toHaveBeenCalledTimes(2);

      controls[0]();
      await flushMicrotasks();

      expect(spawnWorkerFn).toHaveBeenCalledTimes(3);

      controls[1]();
      controls[2]();
      const results = await runPromise;

      expect(results.map((r) => r.outcome)).toEqual(["in-review", "in-review", "in-review"]);
    });

    it("counts activeWorktreeCount from prior cycles against the limit — a cycle starting with 1 active worktree only spawns 1 more", async () => {
      const { fn: spawnWorkerFn, controls } = deferredSpawnWorkerFn();
      const issues = [
        { ...ISSUE, id: "id-a", identifier: "MOV-a" },
        { ...ISSUE, id: "id-b", identifier: "MOV-b" },
      ];
      const ctx = baseCtx({
        spawnWorkerFn,
        concurrencyLimit: 2,
        worktreeManager: fakeWorktreeManager({ activeCount: 1 }),
      });

      const runPromise = runOnce(issues, ctx);
      await flushMicrotasks();

      expect(spawnWorkerFn).toHaveBeenCalledTimes(1);

      controls[0]();
      await flushMicrotasks();

      expect(spawnWorkerFn).toHaveBeenCalledTimes(2);

      controls[1]();
      const results = await runPromise;

      expect(results.map((r) => r.outcome)).toEqual(["in-review", "in-review"]);
    });

    it("kills a hung worker after MOVIECAL_WORKER_TIMEOUT_MS and reports Needs Human Decision with the timeout and log tail", async () => {
      vi.useFakeTimers();
      try {
        let capturedSignal;
        const spawnWorkerFn = vi.fn((args) => {
          capturedSignal = args.signal;
          return new Promise(() => {}); // never resolves — simulates the MOV-106 hang
        });
        const ctx = baseCtx({ spawnWorkerFn, workerTimeoutMs: 1000 });

        const runPromise = runOnce([ISSUE], ctx);
        await vi.advanceTimersByTimeAsync(1000);
        const [result] = await runPromise;

        expect(result.outcome).toBe("timeout");
        expect(result.timeoutMs).toBe(1000);
        expect(capturedSignal.aborted).toBe(true);
        expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);

        const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
        expect(lastMove.stateId).toBe("state-needs-human");

        const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
        expect(lastComment.body).toMatch(/timed out after 1000ms/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let a hung worker in one issue prevent a healthy worker in another issue from completing in the same batch", async () => {
      vi.useFakeTimers();
      try {
        const hungIssue = { ...ISSUE, id: "id-hung", identifier: "MOV-hung" };
        const healthyIssue = { ...ISSUE, id: "id-healthy", identifier: "MOV-healthy" };
        const spawnWorkerFn = vi.fn((args) => {
          if (args.cwd.includes("hung")) return new Promise(() => {});
          return Promise.resolve({ exitCode: 0, logDir: "/fake/logs/healthy" });
        });
        const ctx = baseCtx({ spawnWorkerFn, workerTimeoutMs: 1000, concurrencyLimit: 2 });

        const runPromise = runOnce([hungIssue, healthyIssue], ctx);
        await vi.advanceTimersByTimeAsync(1000);
        const results = await runPromise;

        expect(results.find((r) => r.issue === "MOV-hung").outcome).toBe("timeout");
        expect(results.find((r) => r.issue === "MOV-healthy").outcome).toBe("in-review");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
