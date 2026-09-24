import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce } from "../src/run-loop.mjs";
import { activeAttempt, clearActiveAttempts } from "../src/active-attempt-registry.mjs";
import { buildIsIssueSatisfied } from "../src/dependency-gate.mjs";
import { AgentSessionBridge } from "../src/agent-session.mjs";
import { NESTED_SANDBOX_CRASH } from "../src/failure-classification.mjs";
import { CREDENTIAL_FAILURE } from "../src/credential-failure.mjs";
import { UsageLimitStore } from "../src/usage-limit.mjs";

const STATE_IDS = {
  blocked: "state-blocked",
  agentWorking: "state-agent-working",
  needsHumanDecision: "state-needs-human",
  inReview: "state-in-review",
  readyForAgent: "state-ready-for-agent",
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
    // MOV-181: real run-loop.mjs now calls this, not isPathFree, when
    // building the preflight context -- default to the same behavior so
    // every existing test using this fake is unaffected.
    isPathFreeForIssue: () => pathFree,
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

/**
 * A worktree manager that actually tracks taken paths, so a second pass over
 * the same issue collides the way the real one does (MOV-143 idempotency).
 *
 * `reclaimablePaths` (MOV-181) simulates a path occupied by this same
 * issue's own retained terminal-status worktree: isPathFreeForIssue frees
 * and un-takes it, mirroring WorktreeManager.isPathFreeForIssue's real
 * reclaim behavior. Defaults to empty, so every existing test using this
 * fake without the option keeps today's plain-collision behavior.
 *
 * `dirtyReasons` (MOV-185) simulates a path occupied by this same issue's
 * own terminal-status worktree that is NOT reclaimed because it is dirty:
 * isPathFreeForIssue still blocks (returns false, path stays taken), and
 * reclaimBlockedReason returns the configured string, mirroring the real
 * WorktreeManager's distinguishing-reason pair of methods.
 */
function statefulWorktreeManager({ reclaimablePaths = new Set(), dirtyReasons = new Map() } = {}) {
  const taken = new Set();
  const reclaimed = [];
  return {
    createCalls: [],
    statusCalls: [],
    reclaimed,
    // Exposed (not just closed over) so a test can mark a path reclaimable
    // after discovering it from a prior runOnce()'s createCalls, since the
    // real worktree path is derived inside run-loop.mjs and isn't known
    // ahead of time.
    reclaimablePaths,
    dirtyReasons,
    activeCount: () => taken.size,
    isPathFree: (p) => !taken.has(p),
    isPathFreeForIssue(p, issueId) {
      if (!taken.has(p)) return true;
      if (reclaimablePaths.has(p)) {
        taken.delete(p);
        reclaimed.push({ path: p, issueId });
        return true;
      }
      return false;
    },
    reclaimBlockedReason(p, issueId) {
      return dirtyReasons.get(p) ?? null;
    },
    create(args) {
      const path = `/fake/worktrees/${args.name}`;
      taken.add(path);
      this.createCalls.push(args);
      return { path, ...args };
    },
    prepareWorkerSpawn() {},
    setWorkerPid() {},
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
    repositoryContextFn: vi.fn(() => ({
      branch: "agent/MOV-1-fix-the-thing",
      headSha: "head-sha",
      baseRef: "origin/master",
      baseSha: "base-sha",
      clean: true,
      recentCommits: ["abc snapshot"],
      changedPaths: [],
    })),
    writeWorkerAuditFn: vi.fn(() => ({ path: "/fake/logs/x/security-audit.json", sha256: "abc123" })),
    publishWorkerResultFn: vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true, headSha: "sha-1" })),
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

/**
 * Flush pending microtasks so in-flight promise chains settle before
 * assertions. Each `setImmediate` hop drains the *entire* microtask queue, so
 * this does not have to be re-tuned every time a code path gains an `await`
 * before `spawnWorkerFn` (which is exactly what MOV-158's lifecycle
 * publication did to it).
 */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
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

  // MOV-303: preflight is the one gate every dispatched issue passes through
  // regardless of how it reached Ready for Agent -- unlike the promoter's own
  // gate, which only ever sees issues it promoted itself. `ISSUE` (just
  // `execution:mac`, no project) is already incomplete under the contract, so
  // it is exactly the fixture for this.
  describe("issue-completeness gate (MOV-303)", () => {
    it("dispatches ISSUE unchanged when issueSpecMode is unset (defaults to report)", async () => {
      const ctx = baseCtx();
      const [result] = await runOnce([ISSUE], ctx);
      expect(result.outcome).toBe("in-review");
      expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    });

    it("dispatches ISSUE unchanged in report mode", async () => {
      const ctx = baseCtx({ issueSpecMode: "report" });
      const [result] = await runOnce([ISSUE], ctx);
      expect(result.outcome).toBe("in-review");
      expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    });

    it("blocks an incomplete issue in enforce mode without touching the worktree manager or spawning a worker", async () => {
      const ctx = baseCtx({ issueSpecMode: "enforce" });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("blocked");
      expect(result.reason).toMatch(/incomplete issue spec \(MOV-303\)/);
      expect(ctx.linearClient.calls).toEqual([
        { type: "moveToState", issueId: "id-1", stateId: "state-blocked" },
        { type: "addComment", issueId: "id-1", body: expect.stringContaining("incomplete issue spec (MOV-303)") },
      ]);
      expect(ctx.worktreeManager.createCalls).toHaveLength(0);
      expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    });

    it("still dispatches a fully-specced issue in enforce mode", async () => {
      const ctx = baseCtx({ issueSpecMode: "enforce" });
      const complete = {
        ...ISSUE,
        labels: ["execution:mac", "type:fix", "risk:low", "worker:any", "model:default", "area:process"],
        project: "Autonomous local-agent delivery",
      };

      const [result] = await runOnce([complete], ctx);

      expect(result.outcome).toBe("in-review");
      expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    });
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
    expect(spawnArg.brief).toContain("Repository context (trusted dispatcher snapshot)");
    expect(ctx.repositoryContextFn).toHaveBeenCalledWith({
      worktreePath: "/fake/worktrees/MOV-1-fix-the-thing",
      branch: "agent/MOV-1-fix-the-thing",
    });
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

  it("records a denied scope command as a warning and continues to trusted publication", async () => {
    const publishWorkerResultFn = vi.fn(() => ({
      number: 4,
      url: "https://github.com/owner/repo/pull/4",
      isDraft: true,
      headSha: "sha-4",
    }));
    const ctx = baseCtx({
      publishWorkerResultFn,
      auditWorkerResultFn: vi.fn(() => ({
        ok: true,
        violations: [],
        warnings: [{ action: "git status", reason: "all Git operations are dispatcher-only", category: "scope", outcome: "denied" }],
      })),
    });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result).toMatchObject({ outcome: "in-review" });
    expect(publishWorkerResultFn).toHaveBeenCalledTimes(1);
    expect(ctx.linearClient.calls.some((call) => call.type === "addComment" && call.body.includes("Worker scope warning; no command executed"))).toBe(true);
  });

  it("does not let a denied scope warning mask the worker's actual failed outcome", async () => {
    const ctx = baseCtx({
      spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir: "/fake/logs/MOV-1" })),
      auditWorkerResultFn: vi.fn(() => ({
        ok: true,
        violations: [],
        warnings: [{ action: "git log -1", reason: "all Git operations are dispatcher-only", category: "scope", outcome: "denied" }],
      })),
    });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("worker-failed");
    expect(ctx.linearClient.calls.some((call) => call.type === "addComment" && call.body.includes("Worker scope warning; no command executed"))).toBe(true);
    expect(ctx.linearClient.calls.some((call) => call.type === "addComment" && call.body.includes("Worker exited with code 1"))).toBe(true);
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

    expect(publishWorkerResultFn).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: "/fake/worktrees/MOV-1-fix-the-thing",
      branch: "agent/MOV-1-fix-the-thing",
      repo: "owner/repo",
      issue: ISSUE,
      verificationEvidence: expect.objectContaining({ status: "incomplete" }),
    }));
    expect(ctx.findPrForBranchFn).not.toHaveBeenCalled();
    expect(result.pr).toBe("https://github.com/owner/repo/pull/4");
  });

  it("fails closed when the trusted dispatcher publisher is not configured", async () => {
    const ctx = baseCtx({ publishWorkerResultFn: undefined });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result).toMatchObject({ outcome: "publish-failed", error: "trusted dispatcher publisher is not configured" });
    expect(ctx.findPrForBranchFn).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
    expect(ctx.linearClient.calls.at(-1).body).toContain("trusted dispatcher publisher is not configured");
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
      publishWorkerResultFn: vi.fn(() => null),
      uncommittedChangesFn: vi.fn(() => []),
    });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("no-pr");
    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
    const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
    expect(lastComment.body).toMatch(/found no PR/);
  });

  it("defaults to no-pr when uncommittedChangesFn is not provided (existing callers unaffected)", async () => {
    const ctx = baseCtx({ publishWorkerResultFn: vi.fn(() => null) });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("no-pr");
  });

  it("reports abandoned-dirty (MOV-137) when the worker exits 0 with uncommitted changes and no PR", async () => {
    const uncommittedChangesFn = vi.fn(() => ["src/Auth.swift", "src/AuthTests.swift"]);
    const ctx = baseCtx({
      publishWorkerResultFn: vi.fn(() => null),
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
      ["cloud-routed", { project: "Deferred Linear cloud execution option", labels: ["execution:cloud"] }],
      ["coordination-only", { labels: ["type:coordination", "execution:none"] }],
      ["delegated to a human", { delegate: { id: "user-adam", name: "Adam", displayName: "Adam" } }],
      ["not delegated at all", { delegate: null }],
      [
        "cloud-routed AND delegated elsewhere",
        { project: "Deferred Linear cloud execution option", labels: ["execution:cloud"], delegate: null },
      ],
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
          project: "Deferred Linear cloud execution option",
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

      it("MOV-181: a requeue is NOT blocked by its own retained failed worktree -- it's reclaimed and dispatch proceeds", async () => {
        const worktreeManager = statefulWorktreeManager();
        const ctx = baseCtx({ worktreeManager });

        const [first] = await runOnce([ISSUE], ctx);
        expect(first.outcome).toBe("in-review");
        const failedPath = worktreeManager.createCalls[0] && `/fake/worktrees/${worktreeManager.createCalls[0].name}`;
        worktreeManager.markStatus(ISSUE.identifier, "failed");
        worktreeManager.reclaimablePaths.add(failedPath);

        const [second] = await runOnce([ISSUE], ctx);

        expect(second.outcome).toBe("in-review"); // not "blocked" -- the stale path was reclaimed, not a hard collision
        expect(worktreeManager.reclaimed).toEqual([{ path: failedPath, issueId: ISSUE.identifier }]);
        expect(worktreeManager.createCalls).toHaveLength(2); // dispatched again, a fresh worktree was actually created
        expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(2);
      });

      it("MOV-185: a requeue against its own dirty retained worktree stays blocked with a specific reason, not the generic message", async () => {
        const worktreeManager = statefulWorktreeManager();
        const ctx = baseCtx({ worktreeManager });

        const [first] = await runOnce([ISSUE], ctx);
        expect(first.outcome).toBe("in-review");
        const failedPath = worktreeManager.createCalls[0] && `/fake/worktrees/${worktreeManager.createCalls[0].name}`;
        worktreeManager.markStatus(ISSUE.identifier, "failed");
        worktreeManager.dirtyReasons.set(
          failedPath,
          `worktree at ${failedPath} for ${ISSUE.identifier} has uncommitted changes and was not reclaimed`,
        );

        const [second] = await runOnce([ISSUE], ctx);

        expect(second.outcome).toBe("blocked");
        expect(second.reason).toBe(
          `worktree at ${failedPath} for ${ISSUE.identifier} has uncommitted changes and was not reclaimed`,
        );
        expect(second.reason).not.toMatch(/already in use/);
        expect(worktreeManager.reclaimed).toEqual([]); // not reclaimed
        expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1); // no second dispatch
      });

      it("stays a no-op across repeated cycles for an ineligible issue — no comment spam", async () => {
        const ctx = baseCtx({ worktreeManager: statefulWorktreeManager() });
        const issue = {
          ...ISSUE,
          project: "Deferred Linear cloud execution option",
          labels: ["execution:cloud"],
        };

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

  describe("lifecycle publication and stop controls (MOV-158)", () => {
    /** A Linear client that also speaks the Agent Session surface. */
    function sessionCapableClient() {
      const client = fakeLinearClient();
      client.activities = [];
      client.createAgentSessionOnIssue = vi.fn(async () => ({ id: "session-1" }));
      client.createAgentActivity = vi.fn(async function ({ agentSessionId, content }) {
        this.activities.push({ agentSessionId, content });
        return true;
      });
      client.updateAgentSessionExternalLink = vi.fn(async () => true);
      return client;
    }

    /** A snapshot the stop poller will read. `stateName` drives the incompatible-state case. */
    function freshSnapshot(overrides = {}) {
      return { ...ISSUE, stateName: "Agent Working", ...overrides };
    }

    it("publishes the whole lifecycle as app-actor comments when sessions are off (the default)", async () => {
      const ctx = baseCtx();

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      const comments = ctx.linearClient.calls.filter((c) => c.type === "addComment").map((c) => c.body);
      expect(comments[0]).toContain("**Dispatcher started work.**");
      expect(comments.at(-1)).toContain("**Pull request opened:**");
    });

    it("publishes Agent Activities instead of comments when a session is available", async () => {
      const linearClient = sessionCapableClient();
      const ctx = baseCtx({
        linearClient,
        agentSessionBridgeFn: () => new AgentSessionBridge({ linearClient, enabled: true }),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      expect(linearClient.addComment).not.toHaveBeenCalled();
      expect(linearClient.activities.map((a) => a.content.type)).toEqual(["thought", "action"]);
      // The state transitions are written either way — they are control data.
      expect(linearClient.calls.filter((c) => c.type === "moveToState").map((c) => c.stateId)).toEqual([
        "state-agent-working",
        "state-in-review",
      ]);
    });

    it("attaches the PR URL to the session as an external link as well as in the activity", async () => {
      const linearClient = sessionCapableClient();
      const ctx = baseCtx({
        linearClient,
        agentSessionBridgeFn: () => new AgentSessionBridge({ linearClient, enabled: true }),
      });

      await runOnce([ISSUE], ctx);

      expect(linearClient.updateAgentSessionExternalLink).toHaveBeenCalledWith(
        "session-1",
        "https://github.com/owner/repo/pull/1",
      );
    });

    it("persists the session record so the next attempt can resolve attach-vs-new (polling recovery)", async () => {
      const linearClient = sessionCapableClient();
      const persistAgentSessionFn = vi.fn();
      const ctx = baseCtx({
        linearClient,
        persistAgentSessionFn,
        agentSessionBridgeFn: () => new AgentSessionBridge({ linearClient, enabled: true }),
      });

      await runOnce([ISSUE], ctx);

      expect(persistAgentSessionFn).toHaveBeenCalledWith("MOV-1", expect.objectContaining({ id: "session-1" }));
    });

    it("opens a new linked session when the prior one is terminal, keeping issue/branch/PR identity", async () => {
      const linearClient = sessionCapableClient();
      const ctx = baseCtx({
        linearClient,
        readAgentSessionFn: () => ({ id: "session-prior", status: "complete", attempt: 1 }),
        agentSessionBridgeFn: () => new AgentSessionBridge({ linearClient, enabled: true }),
      });

      await runOnce([ISSUE], ctx);

      expect(linearClient.createAgentSessionOnIssue).toHaveBeenCalledTimes(1);
      const ackBody = linearClient.activities[0].content.body;
      expect(ackBody).toContain("MOV-1");
      expect(ackBody).toContain("agent/MOV-1-fix-the-thing");
      expect(ackBody).toContain("attempt 2");
      expect(ackBody).toContain("continues session session-prior");
    });

    it("keeps working, and keeps commenting, when the Agent Session API is unavailable", async () => {
      const linearClient = sessionCapableClient();
      linearClient.createAgentSessionOnIssue = vi.fn(async () => {
        throw new Error("Linear API error: agent sessions disabled");
      });
      const ctx = baseCtx({
        linearClient,
        agentSessionBridgeFn: () => new AgentSessionBridge({ linearClient, enabled: true }),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      expect(linearClient.addComment).toHaveBeenCalledTimes(2);
      expect(linearClient.createAgentActivity).not.toHaveBeenCalled();
    });

    it("stops silently at the pre-claim boundary when the delegation was removed", async () => {
      const ctx = baseCtx({ refreshIssueFn: vi.fn(async () => freshSnapshot({ delegate: null, stateName: "Ready for Agent" })) });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("not-eligible");
      expect(ctx.linearClient.calls).toEqual([]);
      expect(ctx.worktreeManager.createCalls).toEqual([]);
      expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
    });

    it("stops the worker and writes nothing further when the issue is de-delegated mid-run", async () => {
      let releaseWorker;
      const workerPromise = new Promise((resolve) => {
        releaseWorker = () => resolve({ exitCode: 0, logDir: "/fake/logs/x" });
      });
      let capturedSignal;
      let refreshCount = 0;
      const ctx = baseCtx({
        stopPollIntervalMs: 1,
        spawnWorkerFn: vi.fn((args) => {
          capturedSignal = args.signal;
          return workerPromise;
        }),
        // First call is the pre-claim re-read (still ours), then the human
        // removes the delegation while the worker runs.
        refreshIssueFn: vi.fn(async () => {
          refreshCount += 1;
          return refreshCount === 1 ? freshSnapshot({ stateName: "Ready for Agent" }) : freshSnapshot({ delegate: null });
        }),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("stopped");
      expect(result.reported).toBe(false);
      expect(capturedSignal.aborted).toBe(true);
      // Exactly one write happened for this issue — the `Agent Working` claim
      // report from before the stop. Nothing after the boundary.
      expect(ctx.linearClient.calls.filter((c) => c.type === "addComment")).toHaveLength(1);
      expect(ctx.worktreeManager.statusCalls).toEqual([
        { id: "MOV-1", status: "abandoned", stopReason: expect.stringMatching(/delegated to nobody/) },
      ]);
      expect(ctx.findPrForBranchFn).not.toHaveBeenCalled();
      releaseWorker();
    });

    it("explains itself once when stopped by a cancellation it is still the writer for", async () => {
      let releaseWorker;
      const workerPromise = new Promise((resolve) => {
        releaseWorker = () => resolve({ exitCode: 0, logDir: "/fake/logs/x" });
      });
      let refreshCount = 0;
      const ctx = baseCtx({
        stopPollIntervalMs: 1,
        spawnWorkerFn: vi.fn(() => workerPromise),
        refreshIssueFn: vi.fn(async () => {
          refreshCount += 1;
          return refreshCount === 1 ? freshSnapshot({ stateName: "Ready for Agent" }) : freshSnapshot({ stateName: "Canceled" });
        }),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result).toMatchObject({ outcome: "stopped", reported: true });
      const comments = ctx.linearClient.calls.filter((c) => c.type === "addComment");
      expect(comments).toHaveLength(2);
      expect(comments.at(-1).body).toContain("**Dispatcher stopped at a safe interruption boundary.**");
      expect(comments.at(-1).body).toContain("Canceled");
      // A stop never moves the issue: whoever stopped it already chose a state.
      expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").map((c) => c.stateId)).toEqual([
        "state-agent-working",
      ]);
      releaseWorker();
    });

    it("drops queued activities rather than writing them after a silent stop", async () => {
      // A transient failure earlier in the run leaves an activity queued for
      // retry. If the attempt then stops because the delegation was removed,
      // flushing that queue would be a write to an issue this dispatcher no
      // longer owns — the exact boundary violation the stop exists to prevent.
      const linearClient = sessionCapableClient();
      linearClient.createAgentActivity = vi.fn(async () => {
        throw new Error("fetch failed");
      });
      let releaseWorker;
      const workerPromise = new Promise((resolve) => {
        releaseWorker = () => resolve({ exitCode: 0, logDir: "/fake/logs/x" });
      });
      let refreshCount = 0;
      const ctx = baseCtx({
        linearClient,
        stopPollIntervalMs: 1,
        agentSessionBridgeFn: () => new AgentSessionBridge({ linearClient, enabled: true }),
        spawnWorkerFn: vi.fn(() => workerPromise),
        refreshIssueFn: vi.fn(async () => {
          refreshCount += 1;
          return refreshCount === 1 ? freshSnapshot({ stateName: "Ready for Agent" }) : freshSnapshot({ delegate: null });
        }),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result).toMatchObject({ outcome: "stopped", reported: false });
      // One attempt (the acknowledgement, which failed and queued) and no retry.
      expect(linearClient.createAgentActivity).toHaveBeenCalledTimes(1);
      releaseWorker();
    });

    it("does not treat a transient Linear failure during the stop poll as a stop", async () => {
      let refreshCount = 0;
      const ctx = baseCtx({
        stopPollIntervalMs: 1,
        logger: { error: vi.fn() },
        refreshIssueFn: vi.fn(async () => {
          refreshCount += 1;
          if (refreshCount === 1) return freshSnapshot({ stateName: "Ready for Agent" });
          throw new Error("Linear API error: 503");
        }),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
    });

    it("leaves the stop watcher off, and makes no extra re-reads, when the interval is 0", async () => {
      const refreshIssueFn = vi.fn(async () => freshSnapshot({ stateName: "Ready for Agent" }));
      const ctx = baseCtx({ refreshIssueFn, stopPollIntervalMs: 0 });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      expect(refreshIssueFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("nested-sandbox-crash detection and circuit breaker (MOV-180)", () => {
    /** A minimal fake CircuitBreakerStore that records every call, in-memory only. */
    function fakeCircuitBreaker({ initiallyOpen = false } = {}) {
      let open = initiallyOpen;
      return {
        calls: { isOpen: [], trip: [], clear: [] },
        isOpen(name) {
          this.calls.isOpen.push(name);
          return open;
        },
        trip(name, reason) {
          this.calls.trip.push({ name, reason });
          open = true;
        },
        clear(name) {
          this.calls.clear.push(name);
          open = false;
        },
      };
    }

    let tmpLogRoot;
    beforeEach(() => {
      tmpLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-run-loop-test-"));
    });
    afterEach(() => {
      fs.rmSync(tmpLogRoot, { recursive: true, force: true });
    });

    /** Writes a real stdout.log containing the confirmed MOV-180 signature at `logDir`. */
    function writeCrashLog(logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), "Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted\n");
    }

    function writeCodexGracefulCrashLog(logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, "stdout.log"),
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "Blocked before implementation: the sandbox rejected the initial file-read command with sandbox-exec: sandbox_apply: Operation not permitted.",
          },
        })}\n`,
      );
    }

    it("requeues to Ready for Agent with a distinct comment, and trips the breaker, on the confirmed signature", async () => {
      const circuitBreaker = fakeCircuitBreaker();
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeCrashLog(logDir);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 71, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result).toMatchObject({ outcome: "nested-sandbox-crash", exitCode: 71 });
      expect(circuitBreaker.calls.trip).toEqual([
        { name: NESTED_SANDBOX_CRASH, reason: expect.stringContaining("71") },
      ]);

      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-ready-for-agent");

      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).toContain("Environment failure, not a task failure");
      expect(lastComment.body).toMatch(/every worker on this mac/i);
      expect(lastComment.body).toContain("Ready for Agent");
      expect(lastComment.body).toContain("launchctl bootout");
    });

    it("requeues and trips the breaker when Codex gracefully reports the signature before any tool action", async () => {
      const circuitBreaker = fakeCircuitBreaker();
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeCodexGracefulCrashLog(logDir);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        auditWorkerResultFn: vi.fn(() => ({ ok: true, actions: [], violations: [] })),
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 0, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result).toMatchObject({ outcome: "nested-sandbox-crash", exitCode: 0 });
      expect(circuitBreaker.calls.trip).toEqual([
        { name: NESTED_SANDBOX_CRASH, reason: expect.stringContaining("sandbox_apply: Operation not permitted") },
      ]);
      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-ready-for-agent");
      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).toContain("sandbox_apply: Operation not permitted");
      expect(lastComment.body).toContain("worker exit 0");
    });

    it("does not reclassify a graceful Codex report after an audited tool action", async () => {
      const circuitBreaker = fakeCircuitBreaker();
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeCodexGracefulCrashLog(logDir);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        auditWorkerResultFn: vi.fn(() => ({
          ok: true,
          actions: [{ kind: "command", value: "rg --files", outcome: "executed" }],
          violations: [],
        })),
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 0, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      expect(circuitBreaker.calls.trip).toEqual([]);
    });

    it("does not requeue or trip the breaker for exit code 71 without the sandbox_apply text (not a false positive)", async () => {
      const circuitBreaker = fakeCircuitBreaker();
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), "some other crash, coincidentally exit 71\n");
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 71, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      expect(circuitBreaker.calls.trip).toEqual([]);
      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-needs-human");
    });

    it("leaves an ordinary (non-matching) worker failure completely unaffected — generic-failure path unchanged", async () => {
      const circuitBreaker = fakeCircuitBreaker();
      const ctx = baseCtx({
        circuitBreaker,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir: "/fake/logs/MOV-1" })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      expect(circuitBreaker.calls.trip).toEqual([]);
      expect(circuitBreaker.calls.clear).toEqual([]);
      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-needs-human");
    });

    it("does not dispatch a further issue once the breaker is open — no worktree, no worker, no Linear write", async () => {
      const circuitBreaker = fakeCircuitBreaker({ initiallyOpen: true });
      const ctx = baseCtx({ circuitBreaker, worktreeManager: statefulWorktreeManager() });
      const issueA = { ...ISSUE, id: "id-a", identifier: "MOV-a" };
      const issueB = { ...ISSUE, id: "id-b", identifier: "MOV-b" };

      const results = await runOnce([issueA, issueB], ctx);

      // Exactly one issue (the first) is let through as the half-open probe;
      // the rest are skipped outright.
      const skipped = results.filter((r) => r.outcome === "circuit-breaker-open");
      expect(skipped).toHaveLength(1);
      expect(skipped[0].issue).toBe("MOV-b");
      expect(ctx.worktreeManager.createCalls).toHaveLength(1);
      expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
      expect(ctx.linearClient.calls.some((c) => c.issueId === "id-b")).toBe(false);
    });

    it("closes the breaker once the half-open probe attempt succeeds", async () => {
      const circuitBreaker = fakeCircuitBreaker({ initiallyOpen: true });
      const ctx = baseCtx({ circuitBreaker });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      // MOV-177: a clean worker run clears every dispatch breaker, not just
      // the nested-sandbox one — see run-loop.mjs's DISPATCH_BREAKERS list.
      expect(circuitBreaker.calls.clear).toEqual([NESTED_SANDBOX_CRASH, CREDENTIAL_FAILURE]);
      expect(circuitBreaker.isOpen(NESTED_SANDBOX_CRASH)).toBe(false);
    });

    it("re-trips (stays open) when the half-open probe hits the signature again", async () => {
      const circuitBreaker = fakeCircuitBreaker({ initiallyOpen: true });
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeCrashLog(logDir);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 71, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("nested-sandbox-crash");
      expect(circuitBreaker.isOpen(NESTED_SANDBOX_CRASH)).toBe(true);
    });

    it("is a no-op (defaults to permanently closed) when no circuitBreaker is provided — existing callers unaffected", async () => {
      const ctx = baseCtx();
      expect(ctx.circuitBreaker).toBeUndefined();

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
    });
  });

  describe("credential-failure detection and circuit breaker (MOV-177)", () => {
    /** A minimal fake CircuitBreakerStore that records every call, in-memory only. */
    function fakeCircuitBreaker({ initiallyOpen = false } = {}) {
      let open = initiallyOpen;
      return {
        calls: { isOpen: [], trip: [], clear: [] },
        isOpen(name) {
          this.calls.isOpen.push(name);
          return open;
        },
        trip(name, reason) {
          this.calls.trip.push({ name, reason });
          open = true;
        },
        clear(name) {
          this.calls.clear.push(name);
          open = false;
        },
      };
    }

    let tmpLogRoot;
    beforeEach(() => {
      tmpLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-run-loop-test-"));
    });
    afterEach(() => {
      fs.rmSync(tmpLogRoot, { recursive: true, force: true });
    });

    /** Writes a real stdout.log containing the observed production credential-failure signature. */
    function writeCredentialFailureLog(logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, "stdout.log"),
        "401 OAuth access token has expired. Re-authenticate to continue.\n",
      );
    }

    /**
     * A worktree manager whose activeCount() tracks status the way the real
     * WorktreeManager does (`status === "active"` only) rather than "ever
     * created" — needed to prove the mid-batch breaker recheck below, not
     * preflight's ordinary concurrency gate, is what stops issueB: once
     * issueA is marked "failed" its slot frees up again, exactly as it would
     * in production, so without the breaker fix issueB's own preflight would
     * pass a beat later and it would get dispatched anyway.
     */
    function concurrencyAwareWorktreeManager() {
      const entries = new Map();
      return {
        createCalls: [],
        statusCalls: [],
        activeCount: () => [...entries.values()].filter((e) => e.status === "active").length,
        isPathFree: (p) => ![...entries.values()].some((e) => e.path === p),
        isPathFreeForIssue: (p) => ![...entries.values()].some((e) => e.path === p),
        create(args) {
          const worktreePath = `/fake/worktrees/${args.name}`;
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

    it("produces the distinct 'credential is invalid or expired' comment, not the generic failure comment, and requeues to Ready for Agent", async () => {
      const circuitBreaker = fakeCircuitBreaker();
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeCredentialFailureLog(logDir);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result).toMatchObject({ outcome: "credential-failure", exitCode: 1 });
      expect(circuitBreaker.calls.trip).toEqual([
        { name: CREDENTIAL_FAILURE, reason: expect.stringContaining("OAuth access token has expired") },
      ]);

      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-ready-for-agent");

      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).toContain("**Dispatcher credential is invalid or expired.**");
      expect(lastComment.body).toContain("Automatic dispatch is paused until this is fixed.");
      expect(lastComment.body).not.toContain("Worker exited with code");
    });

    it("does not trip the breaker for an ordinary failure with no auth-failure signature (not a false positive)", async () => {
      const circuitBreaker = fakeCircuitBreaker();
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), "TypeError: cannot read property of undefined\n");
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      expect(circuitBreaker.calls.trip).toEqual([]);
      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-needs-human");
    });

    it("leaves a provider usage-limit failure completely unaffected — distinct, unrelated failure class (regression guard)", async () => {
      const circuitBreaker = fakeCircuitBreaker();
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      fs.mkdirSync(logDir, { recursive: true });
      const resetEpochSeconds = Math.floor((Date.now() + 3600_000) / 1000);
      fs.writeFileSync(path.join(logDir, "stdout.log"), `Claude usage limit reached · reset|${resetEpochSeconds}\n`);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        usageLimitStore: new UsageLimitStore(path.join(tmpLogRoot, "usage-limits.json")),
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("usage-limit-deferred");
      expect(circuitBreaker.calls.trip).toEqual([]);
    });

    it("does not dispatch a further issue once the breaker is already open at the start of a cycle — no worktree, no worker, no Linear write", async () => {
      const circuitBreaker = fakeCircuitBreaker({ initiallyOpen: true });
      const ctx = baseCtx({ circuitBreaker, worktreeManager: statefulWorktreeManager() });
      const issueA = { ...ISSUE, id: "id-a", identifier: "MOV-a" };
      const issueB = { ...ISSUE, id: "id-b", identifier: "MOV-b" };

      const results = await runOnce([issueA, issueB], ctx);

      // Exactly one issue (the first) is let through as the half-open probe;
      // the rest are skipped outright.
      const skipped = results.filter((r) => r.outcome === "circuit-breaker-open");
      expect(skipped).toHaveLength(1);
      expect(skipped[0].issue).toBe("MOV-b");
      expect(ctx.worktreeManager.createCalls).toHaveLength(1);
      expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
      expect(ctx.linearClient.calls.some((c) => c.issueId === "id-b")).toBe(false);
    });

    it("stops claiming further issues for the rest of the SAME cycle once the breaker trips mid-batch (MOV-177)", async () => {
      // The breaker is closed when this batch starts — issueA is the one whose
      // worker actually trips it. Concurrency is 1, matching production
      // (DEFAULT_CONCURRENCY): issueB's own preflight concurrency check would
      // otherwise pass again the instant issueA is marked "failed", which is
      // exactly the "burn through the whole queue one issue at a time" failure
      // mode this issue exists to close.
      const circuitBreaker = fakeCircuitBreaker();
      const logDir = path.join(tmpLogRoot, "MOV-a-fix-the-thing");
      writeCredentialFailureLog(logDir);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        concurrencyLimit: 1,
        worktreeManager: concurrencyAwareWorktreeManager(),
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });
      const issueA = { ...ISSUE, id: "id-a", identifier: "MOV-a" };
      const issueB = { ...ISSUE, id: "id-b", identifier: "MOV-b" };

      const results = await runOnce([issueA, issueB], ctx);

      expect(results[0]).toMatchObject({ issue: "MOV-a", outcome: "credential-failure" });
      expect(results[1]).toMatchObject({ issue: "MOV-b", outcome: "circuit-breaker-open" });
      // issueB never got a worktree or a worker — it was never claimed.
      expect(ctx.worktreeManager.createCalls).toHaveLength(1);
      expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
      expect(ctx.linearClient.calls.some((c) => c.issueId === "id-b")).toBe(false);
    });

    it("closes the breaker once the half-open probe attempt succeeds", async () => {
      const circuitBreaker = fakeCircuitBreaker({ initiallyOpen: true });
      const ctx = baseCtx({ circuitBreaker });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      expect(circuitBreaker.calls.clear).toContain(CREDENTIAL_FAILURE);
      expect(circuitBreaker.isOpen(CREDENTIAL_FAILURE)).toBe(false);
    });

    it("re-trips (stays open) when the half-open probe hits the signature again", async () => {
      const circuitBreaker = fakeCircuitBreaker({ initiallyOpen: true });
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeCredentialFailureLog(logDir);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        circuitBreaker,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("credential-failure");
      expect(circuitBreaker.isOpen(CREDENTIAL_FAILURE)).toBe(true);
    });
  });

  describe("advisory diagnosis for unrecognized failures (MOV-179)", () => {
    let tmpLogRoot;
    beforeEach(() => {
      tmpLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-diagnosis-run-"));
    });
    afterEach(() => {
      fs.rmSync(tmpLogRoot, { recursive: true, force: true });
    });

    function writeOrdinaryFailureLog(logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), "TypeError: cannot read property 'foo' of undefined\n");
    }

    it("splices a confident, grounded diagnosis into the generic worker-failed comment, ahead of the raw log", async () => {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeOrdinaryFailureLog(logDir);
      const diagnoseFailureFn = vi.fn(async () => ({
        ok: true,
        confident: true,
        diagnosis: "The worker crashed with an unhandled TypeError before it could start any real work.",
        evidence: "TypeError: cannot read property 'foo' of undefined",
      }));
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        diagnoseFailureFn,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      expect(diagnoseFailureFn).toHaveBeenCalledTimes(1);
      expect(diagnoseFailureFn).toHaveBeenCalledWith(
        expect.objectContaining({ exitCode: 1, logTail: expect.stringContaining("TypeError") }),
      );

      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).toContain("Diagnosis (advisory, not verified)");
      expect(lastComment.body).toContain("unhandled TypeError");
      expect(lastComment.body).toContain("Evidence:");
      // The raw log tail is still present -- the diagnosis is additive, not a replacement.
      expect(lastComment.body).toContain("TypeError: cannot read property 'foo' of undefined");
      // The diagnosis section reads first, ahead of the raw dump.
      expect(lastComment.body.indexOf("Diagnosis")).toBeLessThan(lastComment.body.indexOf("```"));
    });

    it("states uncertainty explicitly rather than a fabricated cause when the adapter is not confident", async () => {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeOrdinaryFailureLog(logDir);
      const diagnoseFailureFn = vi.fn(async () => ({
        ok: true,
        confident: false,
        diagnosis: "No specific error signature could be confidently identified from the available evidence.",
        evidence: null,
      }));
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        diagnoseFailureFn,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).toContain("not confident");
      expect(lastComment.body).toContain("No specific error signature could be confidently identified");
    });

    it("falls back to today's plain comment when the diagnosis adapter throws — escalation is never blocked on it", async () => {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeOrdinaryFailureLog(logDir);
      const diagnoseFailureFn = vi.fn(async () => {
        throw new Error("rate limited");
      });
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        diagnoseFailureFn,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-needs-human");
      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).not.toContain("Diagnosis");
      expect(lastComment.body).toContain("TypeError: cannot read property 'foo' of undefined");
    });

    it("falls back to today's plain comment when the diagnosis adapter reports ok: false", async () => {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeOrdinaryFailureLog(logDir);
      const diagnoseFailureFn = vi.fn(async () => ({ ok: false, reason: "ANTHROPIC_API_KEY not set" }));
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        diagnoseFailureFn,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).not.toContain("Diagnosis");
    });

    it("never calls the diagnosis adapter when no adapter is wired — existing callers unaffected", async () => {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      writeOrdinaryFailureLog(logDir);
      const ctx = baseCtx({ logRoot: tmpLogRoot, spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })) });
      expect(ctx.diagnoseFailureFn).toBeUndefined();

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).not.toContain("Diagnosis");
    });

    it("never calls the diagnosis adapter for a nested-sandbox-crash — already a dedicated classification", async () => {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), "Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted\n");
      const diagnoseFailureFn = vi.fn(async () => ({ ok: true, confident: true, diagnosis: "should never be seen" }));
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        diagnoseFailureFn,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 71, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("nested-sandbox-crash");
      expect(diagnoseFailureFn).not.toHaveBeenCalled();
    });

    it("never calls the diagnosis adapter for a credential failure — already a dedicated classification", async () => {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), "401 OAuth access token has expired. Re-authenticate to continue.\n");
      const diagnoseFailureFn = vi.fn(async () => ({ ok: true, confident: true, diagnosis: "should never be seen" }));
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        diagnoseFailureFn,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("credential-failure");
      expect(diagnoseFailureFn).not.toHaveBeenCalled();
    });

    it("never calls the diagnosis adapter for a security-policy scope/safety block — the sibling issue's classification", async () => {
      const diagnoseFailureFn = vi.fn(async () => ({ ok: true, confident: true, diagnosis: "should never be seen" }));
      const ctx = baseCtx({
        diagnoseFailureFn,
        auditWorkerResultFn: vi.fn(() => ({
          ok: false,
          violations: [{ action: "gh api -X DELETE repos/o/r/rulesets/1", reason: "direct GitHub API access" }],
        })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("security-blocked");
      expect(diagnoseFailureFn).not.toHaveBeenCalled();
    });

    it("never calls the diagnosis adapter for a recognized, reset-bearing provider usage limit — already a dedicated classification", async () => {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), "Claude AI usage limit reached · resets 2026-09-14T17:00:00Z\n");
      const diagnoseFailureFn = vi.fn(async () => ({ ok: true, confident: true, diagnosis: "should never be seen" }));
      const usageLimitStore = {
        get: () => null,
        record: (_id, data) => data,
        clear: () => {},
        deferral: () => ({ deferred: false, until: null, reason: null }),
      };
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        diagnoseFailureFn,
        usageLimitStore,
        now: () => new Date("2026-09-14T12:00:00.000Z"),
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("usage-limit-deferred");
      expect(diagnoseFailureFn).not.toHaveBeenCalled();
    });

    it("calls the diagnosis adapter exactly once and splices its diagnosis into the publish-failed comment", async () => {
      const diagnoseFailureFn = vi.fn(async () => ({
        ok: true,
        confident: true,
        diagnosis: "The non-force push was rejected because the remote branch has diverged.",
        evidence: "! [rejected] agent/MOV-1-fix-the-thing -> agent/MOV-1-fix-the-thing (non-fast-forward)",
      }));
      const publishWorkerResultFn = vi.fn(() => {
        throw new Error("git push rejected: non-fast-forward");
      });
      const ctx = baseCtx({ diagnoseFailureFn, publishWorkerResultFn });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("publish-failed");
      expect(diagnoseFailureFn).toHaveBeenCalledTimes(1);
      expect(diagnoseFailureFn).toHaveBeenCalledWith(
        expect.objectContaining({ auditText: expect.stringContaining("non-fast-forward") }),
      );
      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).toContain("Diagnosis (advisory, not verified)");
      expect(lastComment.body).toContain("remote branch has diverged");
    });

    it("still escalates the publish-failed comment, unblocked, when the diagnosis adapter fails", async () => {
      const diagnoseFailureFn = vi.fn(async () => {
        throw new Error("diagnosis call timed out");
      });
      const publishWorkerResultFn = vi.fn(() => {
        throw new Error("git push rejected: non-fast-forward");
      });
      const ctx = baseCtx({ diagnoseFailureFn, publishWorkerResultFn });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result).toMatchObject({ outcome: "publish-failed", error: "git push rejected: non-fast-forward" });
      expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).not.toContain("Diagnosis");
      expect(lastComment.body).toContain("git push rejected: non-fast-forward");
    });
  });

  describe("dispatch-time provider usage limit (MOV-151)", () => {
    const NOW = new Date("2026-09-14T12:00:00.000Z");
    const USAGE_LIMIT_LOG = "Claude AI usage limit reached · resets 2026-09-14T17:00:00Z\n";

    /**
     * A minimal in-memory UsageLimitStore with the same surface run-loop uses,
     * including MOV-205's resume plan (`record({resume})` / `resumption()` /
     * `consumeResume()`).
     */
    function fakeUsageLimitStore(initial = {}) {
      const state = { ...initial };
      return {
        state,
        cleared: [],
        get: (id) => state[id] || null,
        record(id, { retryAt, evidence, consecutive, resume = null }) {
          state[id] = { issue: id, retryAt, evidence, consecutive, resume: resume ? { ...resume, consumedAt: null } : null };
          return state[id];
        },
        clear(id) {
          this.cleared.push(id);
          delete state[id];
        },
        deferral(id, now) {
          const record = state[id];
          if (!record?.retryAt || now >= new Date(record.retryAt)) return { deferred: false, until: record?.retryAt ?? null, reason: null };
          return { deferred: true, until: record.retryAt, reason: `awaiting the provider usage-limit reset at ${record.retryAt}` };
        },
        resumption(id, now) {
          const record = state[id];
          const plan = record?.resume;
          if (!plan || plan.consumedAt || !record.retryAt) return null;
          if (now < new Date(record.retryAt)) return null;
          return { ...plan, issue: id, retryAt: record.retryAt, consecutive: record.consecutive || 0 };
        },
        consumeResume(id, { now }) {
          const record = state[id];
          if (!record?.resume || record.resume.consumedAt) return null;
          record.resume = { ...record.resume, consumedAt: now.toISOString() };
          record.retryAt = null;
          return record;
        },
      };
    }

    let tmpLogRoot;
    beforeEach(() => {
      tmpLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-usage-limit-run-"));
    });
    afterEach(() => {
      fs.rmSync(tmpLogRoot, { recursive: true, force: true });
    });

    function withLog(contents) {
      const logDir = path.join(tmpLogRoot, "MOV-1-fix-the-thing");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "stdout.log"), contents);
      return logDir;
    }

    // Acceptance criterion: "A worker that exits non-zero solely because of a
    // provider usage/rate limit is retried once at the parsed reset time
    // instead of being permanently escalated."
    it("requeues to Ready for Agent and schedules one retry at the parsed reset time", async () => {
      const usageLimitStore = fakeUsageLimitStore();
      const logDir = withLog(USAGE_LIMIT_LOG);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        usageLimitStore,
        now: () => NOW,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result).toMatchObject({ outcome: "usage-limit-deferred", retryAt: "2026-09-14T17:00:00.000Z" });
      expect(usageLimitStore.state["MOV-1"]).toMatchObject({ consecutive: 1, retryAt: "2026-09-14T17:00:00.000Z" });

      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-ready-for-agent");
      const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
      expect(lastComment.body).toContain("Provider usage limit, not a task failure");
      expect(lastComment.body).toContain("2026-09-14T17:00:00.000Z");
    });

    it("holds the issue back, silently, until the reset time passes", async () => {
      const usageLimitStore = fakeUsageLimitStore({
        "MOV-1": { issue: "MOV-1", consecutive: 1, retryAt: "2026-09-14T17:00:00.000Z" },
      });
      const ctx = baseCtx({ usageLimitStore, now: () => NOW });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result).toMatchObject({ outcome: "deferred-usage-limit", retryAt: "2026-09-14T17:00:00.000Z" });
      // Nothing claimed, nothing spawned, and — crucially for a 30s poll
      // loop — nothing written to Linear.
      expect(ctx.worktreeManager.createCalls).toEqual([]);
      expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
      expect(ctx.linearClient.calls).toEqual([]);
    });

    it("dispatches again once the reset time has passed", async () => {
      const usageLimitStore = fakeUsageLimitStore({
        "MOV-1": { issue: "MOV-1", consecutive: 1, retryAt: "2026-09-14T17:00:00.000Z" },
      });
      const ctx = baseCtx({ usageLimitStore, now: () => new Date("2026-09-14T17:00:01Z") });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("in-review");
      // A session that ran to a clean exit means the history is no longer consecutive.
      expect(usageLimitStore.cleared).toContain("MOV-1");
    });

    // Acceptance criterion: "a second consecutive usage-limit failure on the
    // same issue escalates."
    it("escalates the second consecutive usage-limit failure", async () => {
      const usageLimitStore = fakeUsageLimitStore({
        "MOV-1": { issue: "MOV-1", consecutive: 1, retryAt: "2026-09-14T11:00:00.000Z" },
      });
      const logDir = withLog(USAGE_LIMIT_LOG);
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        usageLimitStore,
        now: () => NOW,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      expect(result.usageLimit).toMatch(/second consecutive/);
      expect(usageLimitStore.state["MOV-1"].consecutive).toBe(2);
      const lastMove = ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1);
      expect(lastMove.stateId).toBe("state-needs-human");
    });

    it("escalates a usage-limit message whose reset time cannot be parsed", async () => {
      const usageLimitStore = fakeUsageLimitStore();
      const logDir = withLog("session limit reached, resetting at some point\n");
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        usageLimitStore,
        now: () => NOW,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      expect(result.usageLimit).toMatch(/no reset time could be parsed/);
      expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-needs-human");
    });

    // Acceptance criterion: "Any other non-zero worker exit is not treated as
    // the usage-limit class and still escalates immediately as today."
    it("leaves an ordinary worker failure on the existing escalation path and forgets any usage history", async () => {
      const usageLimitStore = fakeUsageLimitStore({
        "MOV-1": { issue: "MOV-1", consecutive: 1, retryAt: "2026-09-14T11:00:00.000Z" },
      });
      const logDir = withLog("FAIL test/widget.test.ts — expected 1 to be 2\n");
      const ctx = baseCtx({
        logRoot: tmpLogRoot,
        usageLimitStore,
        now: () => NOW,
        spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
      });

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      expect(result.usageLimit).toBeUndefined();
      expect(usageLimitStore.cleared).toContain("MOV-1");
      expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-needs-human");
    });

    // Without a durable store the "exactly one retry" bound cannot be
    // enforced — a requeue would simply loop — so the retry is refused and
    // the issue escalates exactly as it did before MOV-151.
    it("refuses to requeue when no usageLimitStore is provided — existing callers unaffected", async () => {
      const logDir = withLog(USAGE_LIMIT_LOG);
      const ctx = baseCtx({ logRoot: tmpLogRoot, spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })) });
      expect(ctx.usageLimitStore).toBeUndefined();

      const [result] = await runOnce([ISSUE], ctx);

      expect(result.outcome).toBe("worker-failed");
      expect(result.usageLimit).toMatch(/could not be recorded durably/);
      expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-needs-human");
    });

    // MOV-205. Everything above is MOV-151's *clean*-worktree case, which is
    // deliberately unchanged. This block is the case it refused to handle: the
    // limit landed after the worker had already produced unpublished changes,
    // so the retry has to resume the retained worktree in place rather than
    // ask for a new one.
    describe("resuming a retained dirty worktree (MOV-205)", () => {
      const RESUME_PATH = "/fake/worktrees/MOV-1-fix-the-thing";
      const RESUME_BRANCH = "agent/MOV-1-fix-the-thing";
      const RESUME_AT = "2026-09-14T17:00:00.000Z";
      const AFTER_RESET = new Date("2026-09-14T17:00:01Z");
      const UNPUBLISHED = ["src/partial.ts"];

      function resumePlan(overrides = {}) {
        return {
          worktreePath: RESUME_PATH,
          branch: RESUME_BRANCH,
          repository: "owner/repo",
          retryAt: RESUME_AT,
          unpublishedPaths: UNPUBLISHED,
          consumedAt: null,
          ...overrides,
        };
      }

      /** A store holding exactly the record a MOV-205 deferral leaves behind. */
      function storeAwaitingResume(planOverrides = {}) {
        return fakeUsageLimitStore({
          "MOV-1": { issue: "MOV-1", consecutive: 1, retryAt: RESUME_AT, resume: resumePlan(planOverrides) },
        });
      }

      /**
       * A worktree manager whose only entry is this issue's retained, dirty
       * worktree. `isPathFreeForIssue` always refuses (it is dirty, MOV-185),
       * so any test where the resume path is NOT taken collides at preflight
       * — which is exactly the pre-MOV-205 behaviour, and makes "the resume
       * really happened" unambiguous rather than incidental.
       */
      function retainedWorktreeManager({ entry = {}, owned = true, integrity } = {}) {
        const state = {
          "MOV-1": {
            id: "MOV-1",
            name: "MOV-1-fix-the-thing",
            branch: RESUME_BRANCH,
            path: RESUME_PATH,
            status: "failed",
            usageLimitResumeAt: RESUME_AT,
            retainedForResume: true,
            provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" },
            ...entry,
          },
        };
        return {
          createCalls: [],
          statusCalls: [],
          resumeCalls: [],
          reclaimChecks: [],
          state,
          activeCount: () => 0,
          isPathFree: () => false,
          isPathFreeForIssue(p, id) {
            this.reclaimChecks.push({ path: p, issue: id });
            return false;
          },
          reclaimBlockedReason: () => `worktree at ${RESUME_PATH} for MOV-1 has uncommitted changes`,
          loadState: () => state,
          isDispatcherOwnedWorktree: () => owned,
          worktreeIntegrity: () => integrity ?? { intact: true, branch: RESUME_BRANCH, reason: null },
          create(args) {
            this.createCalls.push(args);
            return { path: `/fake/worktrees/${args.name}`, ...args };
          },
          resumeEntry(id, opts) {
            this.resumeCalls.push({ id, ...opts });
            state[id] = { ...state[id], status: "active", resumeCount: (state[id].resumeCount || 0) + 1 };
            return state[id];
          },
          markStatus(id, status, extra = {}) {
            this.statusCalls.push({ id, status, ...extra });
          },
        };
      }

      function resumeCtx(overrides = {}) {
        return baseCtx({
          worktreeManager: retainedWorktreeManager(overrides.manager ?? {}),
          usageLimitStore: overrides.usageLimitStore ?? storeAwaitingResume(),
          uncommittedChangesFn: vi.fn(() => UNPUBLISHED),
          logRoot: tmpLogRoot,
          now: () => AFTER_RESET,
          ...overrides.ctx,
        });
      }

      // Acceptance criterion: "A recognized, reset-bearing provider usage limit
      // after unpublished changes retains the same dispatcher-owned worktree
      // and schedules one deferred resume; it does not move directly to Needs
      // Human Decision."
      it("schedules one in-place resume instead of escalating, and retains the worktree", async () => {
        const usageLimitStore = fakeUsageLimitStore();
        const logDir = withLog(USAGE_LIMIT_LOG);
        const ctx = baseCtx({
          logRoot: tmpLogRoot,
          usageLimitStore,
          uncommittedChangesFn: vi.fn(() => UNPUBLISHED),
          now: () => NOW,
          spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
        });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result).toMatchObject({
          outcome: "usage-limit-resume-deferred",
          retryAt: RESUME_AT,
          worktreePath: RESUME_PATH,
          uncommittedPaths: UNPUBLISHED,
        });
        expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-ready-for-agent");

        // Both halves of the durable record: the store's plan and the
        // registry's matching stamp, which re-admission cross-checks.
        expect(usageLimitStore.state["MOV-1"]).toMatchObject({
          consecutive: 1,
          retryAt: RESUME_AT,
          resume: { worktreePath: RESUME_PATH, branch: RESUME_BRANCH, repository: "owner/repo", unpublishedPaths: UNPUBLISHED },
        });
        expect(ctx.worktreeManager.statusCalls.at(-1)).toMatchObject({
          id: "MOV-1",
          status: "failed",
          usageLimitResumeAt: RESUME_AT,
          retainedForResume: true,
        });

        const body = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1).body;
        expect(body).toContain("resumed in place");
        expect(body).toContain("src/partial.ts");
        expect(body).toMatch(/not.*reclaimed, removed, or replaced/);
      });

      // Acceptance criterion: "The durable record ... prevents dispatch before
      // the provider reset."
      it("holds the issue back silently until the reset, claiming nothing", async () => {
        const ctx = resumeCtx({ ctx: { now: () => NOW } });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result).toMatchObject({ outcome: "deferred-usage-limit", retryAt: RESUME_AT });
        expect(ctx.worktreeManager.createCalls).toEqual([]);
        expect(ctx.worktreeManager.resumeCalls).toEqual([]);
        expect(ctx.worktreeManager.reclaimChecks).toEqual([]);
        expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
        expect(ctx.linearClient.calls).toEqual([]);
      });

      // Acceptance criterion: "The resumed worker runs only in that retained
      // worktree and same branch; no reclaim, new worktree, or branch deletion
      // occurs."
      it("resumes in the retained worktree once the reset passes, without creating or reclaiming anything", async () => {
        const usageLimitStore = storeAwaitingResume();
        const ctx = resumeCtx({ usageLimitStore });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("in-review");
        expect(ctx.worktreeManager.resumeCalls).toEqual([
          { id: "MOV-1", worktreePath: RESUME_PATH, branch: RESUME_BRANCH },
        ]);
        expect(ctx.worktreeManager.createCalls).toEqual([]);
        // The MOV-181/185 reclaim check is never even consulted on this path,
        // so there is no way for it to remove the retained worktree.
        expect(ctx.worktreeManager.reclaimChecks).toEqual([]);
        expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
        expect(ctx.spawnWorkerFn.mock.calls[0][0].cwd).toBe(RESUME_PATH);
        // Same branch, same worktree, and the PR is published from it.
        expect(ctx.publishWorkerResultFn.mock.calls[0][0]).toMatchObject({
          worktreePath: RESUME_PATH,
          branch: RESUME_BRANCH,
        });
      });

      it("tells Linear and the worker that this is a resume of the retained worktree", async () => {
        const ctx = resumeCtx();

        await runOnce([ISSUE], ctx);

        const acknowledged = ctx.linearClient.calls.filter((c) => c.type === "addComment")[0].body;
        expect(acknowledged).toContain("resumed the retained worktree");
        expect(acknowledged).toContain(RESUME_PATH);
        expect(acknowledged).toContain("src/partial.ts");

        const brief = ctx.spawnWorkerFn.mock.calls[0][0].brief;
        expect(brief).toContain("You are resuming an interrupted attempt");
        expect(brief).toContain("Continue that work; do not discard it.");
        expect(brief).toContain("src/partial.ts");
      });

      // The plan is spent when the resume *starts*, not when it succeeds — so
      // an attempt that dies anywhere in between cannot hand the next poll
      // cycle a second worker against the same worktree.
      it("spends the plan before the worker starts, so a failed attempt cannot re-fire it", async () => {
        const usageLimitStore = storeAwaitingResume();
        const ctx = resumeCtx({
          usageLimitStore,
          ctx: {
            spawnWorkerFn: vi.fn(async () => {
              throw new Error("sandbox could not be applied");
            }),
          },
        });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("spawn-error");
        expect(usageLimitStore.state["MOV-1"].resume.consumedAt).toEqual(expect.any(String));
        expect(usageLimitStore.resumption("MOV-1", AFTER_RESET)).toBeNull();
        // ...and the consecutive count is deliberately kept, so a later
        // provider limit is still counted as the second one.
        expect(usageLimitStore.state["MOV-1"].consecutive).toBe(1);
      });

      it("forgets the usage history once the resumed worker runs to a clean publication", async () => {
        const usageLimitStore = storeAwaitingResume();
        const ctx = resumeCtx({ usageLimitStore });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("in-review");
        expect(usageLimitStore.cleared).toContain("MOV-1");
        expect(usageLimitStore.state["MOV-1"]).toBeUndefined();
      });

      // Acceptance criterion: "The attempt is bounded: a second consecutive
      // provider limit ... moves the issue to Needs Human Decision with an
      // actionable reason."
      it("escalates a second consecutive provider limit rather than scheduling another resume", async () => {
        const usageLimitStore = storeAwaitingResume();
        const logDir = withLog(USAGE_LIMIT_LOG);
        const ctx = resumeCtx({
          usageLimitStore,
          ctx: { spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })) },
        });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("worker-failed");
        expect(result.usageLimit).toMatch(/second consecutive/);
        expect(result.uncommittedPaths).toEqual(UNPUBLISHED);
        expect(usageLimitStore.state["MOV-1"]).toMatchObject({ consecutive: 2, retryAt: null, resume: null });
        expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-needs-human");
        const body = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1).body;
        expect(body).toMatch(/will not requeue, reclaim, or remove it automatically/);
        // Retained, not reclaimed — the second limit must not cost the work either.
        expect(ctx.worktreeManager.statusCalls.at(-1)).toMatchObject({ id: "MOV-1", status: "failed" });
        expect(ctx.worktreeManager.statusCalls.at(-1).usageLimitResumeAt).toBeUndefined();
      });

      it.each([
        ["the reset time cannot be parsed", "session limit reached, resetting at some point\n", /no reset time could be parsed/],
        [
          "the reset is further away than this dispatcher will park an issue",
          "usage limit reached · resets 2026-09-20T17:00:00Z\n",
          /more than 24h away/,
        ],
      ])("escalates and retains when %s", async (_label, log, expected) => {
        const usageLimitStore = fakeUsageLimitStore();
        const logDir = withLog(log);
        const ctx = baseCtx({
          logRoot: tmpLogRoot,
          usageLimitStore,
          uncommittedChangesFn: vi.fn(() => UNPUBLISHED),
          now: () => NOW,
          spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
        });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("worker-failed");
        expect(result.usageLimit).toMatch(expected);
        expect(result.uncommittedPaths).toEqual(UNPUBLISHED);
        expect(usageLimitStore.state["MOV-1"].resume).toBeNull();
        expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-needs-human");
      });

      // Without a durable record the "exactly one resume" bound does not
      // exist, so this degrades to MOV-151's escalation rather than to a loop.
      it("escalates when the resume cannot be recorded durably", async () => {
        const logDir = withLog(USAGE_LIMIT_LOG);
        const ctx = baseCtx({
          logRoot: tmpLogRoot,
          uncommittedChangesFn: vi.fn(() => UNPUBLISHED),
          now: () => NOW,
          spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
        });
        expect(ctx.usageLimitStore).toBeUndefined();

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("worker-failed");
        expect(result.usageLimit).toMatch(/could not be recorded durably/);
        expect(result.uncommittedPaths).toEqual(UNPUBLISHED);
        expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-needs-human");
      });

      // Acceptance criterion: "Before resuming, the dispatcher revalidates
      // dispatcher ownership, worktree integrity, branch/remote identity,
      // unchanged target provenance ... [and] any failed re-admission ...
      // moves the issue to Needs Human Decision with an actionable reason."
      it.each([
        [
          "the worktree is not provably dispatcher-owned",
          { manager: { owned: false } },
          /not provably dispatcher-owned/,
        ],
        [
          "the worktree is no longer intact",
          { manager: { integrity: { intact: false, branch: null, reason: "retained worktree is on master, not agent/MOV-1-fix-the-thing" } } },
          /is on master, not/,
        ],
        [
          "the registry entry lost its approved-executor provenance",
          { manager: { entry: { provenance: { executor: "someone-else", repository: "owner/repo" } } } },
          /lacks approved-executor provenance/,
        ],
        [
          "a worker is already active in the entry",
          { manager: { entry: { status: "active" } } },
          /not the retained "failed" state/,
        ],
        [
          "the registry's scheduled reset no longer matches the durable record",
          { manager: { entry: { usageLimitResumeAt: "2026-09-14T21:00:00.000Z" } } },
          /does not match the durable record/,
        ],
        [
          "the unpublished work the resume existed to carry is gone",
          { ctx: { uncommittedChangesFn: vi.fn(() => []) } },
          /no longer holds the unpublished changes/,
        ],
      ])("refuses to resume when %s, and leaves the worktree alone", async (_label, overrides, expected) => {
        const usageLimitStore = storeAwaitingResume();
        const ctx = resumeCtx({ usageLimitStore, ...overrides });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result).toMatchObject({ outcome: "needs-human", usageLimitResume: "refused" });
        expect(result.reason).toMatch(expected);
        expect(ctx.worktreeManager.resumeCalls).toEqual([]);
        expect(ctx.worktreeManager.createCalls).toEqual([]);
        expect(ctx.worktreeManager.reclaimChecks).toEqual([]);
        expect(ctx.worktreeManager.statusCalls).toEqual([]);
        expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
        expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-needs-human");
        const body = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1).body;
        expect(body).toContain("was refused");
        expect(body).toMatch(/not.*reclaimed, removed, or replaced/);
        // Spent either way, so the refusal is reported once rather than on
        // every 30-second poll.
        expect(usageLimitStore.resumption("MOV-1", AFTER_RESET)).toBeNull();
      });

      it("reports the specific re-admission reason, not a generic failure", async () => {
        const ctx = resumeCtx({ manager: { owned: false } });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.reason).toMatch(/not provably dispatcher-owned/);
        expect(ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1).body).toMatch(
          /not provably dispatcher-owned/,
        );
      });

      it("escalates when the retained worktree cannot be re-opened, without removing it", async () => {
        const ctx = resumeCtx();
        ctx.worktreeManager.resumeEntry = () => {
          throw new Error("retained worktree for MOV-1 no longer exists at /fake/worktrees/MOV-1-fix-the-thing");
        };

        const [result] = await runOnce([ISSUE], ctx);

        expect(result).toMatchObject({ outcome: "needs-human", usageLimitResume: "refused" });
        expect(result.reason).toMatch(/could not be re-opened/);
        expect(ctx.worktreeManager.createCalls).toEqual([]);
        expect(ctx.spawnWorkerFn).not.toHaveBeenCalled();
      });

      // Acceptance criterion: "a non-limit worker failure moves the issue to
      // Needs Human Decision".
      it("escalates an ordinary failure in the resumed worker and forgets the usage history", async () => {
        const usageLimitStore = storeAwaitingResume();
        const logDir = withLog("FAIL test/widget.test.ts — expected 1 to be 2\n");
        const ctx = resumeCtx({
          usageLimitStore,
          ctx: { spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })) },
        });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("worker-failed");
        expect(result.usageLimit).toBeUndefined();
        expect(usageLimitStore.cleared).toContain("MOV-1");
        expect(ctx.linearClient.calls.filter((c) => c.type === "moveToState").at(-1).stateId).toBe("state-needs-human");
      });

      // Acceptance criterion: "Existing clean-worktree usage-limit deferral
      // behavior remains unchanged." A clean deferral must record no resume
      // plan at all, or the next cycle would try to resume a worktree that was
      // going to be reclaimed and rebuilt.
      it("records no resume plan on the clean-worktree path", async () => {
        const usageLimitStore = fakeUsageLimitStore();
        const logDir = withLog(USAGE_LIMIT_LOG);
        const ctx = baseCtx({
          logRoot: tmpLogRoot,
          usageLimitStore,
          now: () => NOW,
          spawnWorkerFn: vi.fn(async () => ({ exitCode: 1, logDir })),
        });

        const [result] = await runOnce([ISSUE], ctx);

        expect(result.outcome).toBe("usage-limit-deferred");
        expect(usageLimitStore.state["MOV-1"].resume).toBeNull();
        expect(usageLimitStore.resumption("MOV-1", new Date("2026-09-14T18:00:00Z"))).toBeNull();
      });
    });
  });
});

// MOV-166: an in-flight attempt must be findable by issue id (for an inbound
// Agent Session signal to route to), and only for as long as it is actually
// in flight -- registered once claimed, unregistered once settled, whatever
// the outcome.
describe("active-attempt registry wiring", () => {
  beforeEach(() => {
    clearActiveAttempts();
  });

  it("registers the attempt while the worker runs, and unregisters it once runOnce settles", async () => {
    const deferred = deferredSpawnWorkerFn();
    const ctx = baseCtx({ spawnWorkerFn: deferred.fn });

    const runPromise = runOnce([ISSUE], ctx);
    await flushMicrotasks();

    const entry = activeAttempt(ISSUE.id);
    expect(entry).not.toBeNull();
    expect(entry.identifier).toBe("MOV-1");
    expect(entry.controller.stopped).toBe(false);
    expect(entry.publisher).toBeDefined();

    deferred.controls[0]();
    await runPromise;

    expect(activeAttempt(ISSUE.id)).toBeNull();
  });

  it("unregisters even when the attempt is not eligible and never reaches registration", async () => {
    const ctx = baseCtx();
    const issue = { ...ISSUE, labels: [...ISSUE.labels, "human-only"] };

    await runOnce([issue], ctx);

    expect(activeAttempt(issue.id)).toBeNull();
  });
});

/**
 * A steering-capable fake spawnWorkerFn: exposes writeTurn/requestClose/
 * nextTurnBoundary the same shape the real spawnWorker() returns, with a
 * test-controlled `fireTurnBoundary()` standing in for the worker's own
 * stream-json `result` line.
 */
function fakeSteeringSpawnWorkerFn() {
  const writeTurns = [];
  let closed = false;
  let resolveExit;
  const promise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let waiter = null;
  function fireTurnBoundary() {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ ended: false });
    }
  }
  const fn = vi.fn(() => ({
    promise,
    writeTurn: (text) => {
      writeTurns.push(text);
    },
    requestClose: () => {
      closed = true;
      resolveExit({ exitCode: 0, logDir: "/fake/logs/x" });
    },
    nextTurnBoundary: () =>
      new Promise((resolve) => {
        waiter = resolve;
      }),
  }));
  return { fn, writeTurns, isClosed: () => closed, fireTurnBoundary };
}

// MOV-214/215: live mid-run prompt delivery. Off by default (steeringEnabled
// undefined in every other test in this file, which is why they all still
// exercise today's exact one-shot spawnWorkerFn contract).
describe("steering turn-loop wiring", () => {
  beforeEach(() => {
    clearActiveAttempts();
  });

  it("closes stdin at the first turn boundary when nothing is queued -- identical timing to the no-steering path", async () => {
    const steering = fakeSteeringSpawnWorkerFn();
    const ctx = baseCtx({ spawnWorkerFn: steering.fn, steeringEnabled: true });

    const runPromise = runOnce([ISSUE], ctx);
    await flushMicrotasks();
    steering.fireTurnBoundary();
    await runPromise;

    expect(steering.isClosed()).toBe(true);
    expect(steering.writeTurns).toEqual([]);
    expect(steering.fn.mock.calls[0][0]).toMatchObject({ steering: true });
  });

  it("registers queuePrompt on the active attempt, and writes a queued prompt as the next turn instead of closing", async () => {
    const steering = fakeSteeringSpawnWorkerFn();
    const ctx = baseCtx({ spawnWorkerFn: steering.fn, steeringEnabled: true });

    const runPromise = runOnce([ISSUE], ctx);
    await flushMicrotasks();

    const entry = activeAttempt(ISSUE.id);
    expect(typeof entry.queuePrompt).toBe("function");
    entry.queuePrompt("also update the docs");

    steering.fireTurnBoundary(); // worker's first (and only, for this test) turn completes
    await flushMicrotasks();

    expect(steering.writeTurns).toEqual(["also update the docs"]);
    expect(steering.isClosed()).toBe(false); // a turn was written, not a close

    // Nothing further queued -> the next boundary closes stdin, same as the
    // no-prompt path.
    steering.fireTurnBoundary();
    await runPromise;
    expect(steering.isClosed()).toBe(true);
  });

  it("does not add --input-format/steering behavior for a codex-routed attempt", async () => {
    const steering = fakeSteeringSpawnWorkerFn();
    const ctx = baseCtx({
      spawnWorkerFn: steering.fn,
      steeringEnabled: true,
    });
    const issue = { ...ISSUE, labels: [...ISSUE.labels, "worker:codex"] };

    const runPromise = runOnce([issue], ctx);
    await flushMicrotasks();
    steering.fireTurnBoundary();
    await runPromise;

    expect(steering.fn.mock.calls[0][0]).toMatchObject({ steering: false });
    expect(steering.fn.mock.calls[0][0].invocation.command).toBe("codex");
  });
});
