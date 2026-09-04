import { describe, it, expect, vi } from "vitest";
import { runOnce } from "../src/run-loop.mjs";

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
    markStatus(id, status) {
      this.statusCalls.push({ id, status });
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
    concurrencyLimit: 2,
    iosRunnerOnline: true,
    secretPresent: () => true,
    worktreeRoot: "/fake/worktrees",
    envLocalSource: undefined,
    ghRepo: "owner/repo",
    logRoot: "/fake/logs",
    spawnWorkerFn: vi.fn(async () => ({ exitCode: 0, logDir: "/fake/logs/x" })),
    findPrForBranchFn: vi.fn(() => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true })),
    ...overrides,
  };
}

const ISSUE = {
  id: "id-1",
  identifier: "MOV-1",
  title: "Fix the thing",
  description: "Do the fix.",
  url: "https://linear.app/moviecal/issue/MOV-1",
  project: null,
  labels: [],
  blockedByIds: [],
};

describe("runOnce", () => {
  it("moves a human-only issue to blocked without touching the worktree manager", async () => {
    const ctx = baseCtx();
    const issue = { ...ISSUE, labels: ["human-only"] };

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
    const issue = { ...ISSUE, labels: ["model:strong"] };

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
    expect(ctx.worktreeManager.createCalls[0]).toMatchObject({ id: "MOV-1", worker: "claude" });

    const stateChanges = ctx.linearClient.calls.filter((c) => c.type === "moveToState").map((c) => c.stateId);
    expect(stateChanges).toEqual(["state-agent-working", "state-in-review"]);

    expect(ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    const spawnArg = ctx.spawnWorkerFn.mock.calls[0][0];
    expect(spawnArg.cwd).toBe("/fake/worktrees/MOV-1-fix-the-thing");
    expect(spawnArg.brief).toContain("MOV-1");

    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "review" }]);
    expect(result).toEqual({ issue: "MOV-1", outcome: "in-review", pr: "https://github.com/owner/repo/pull/1" });
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

  it("marks failed and reports needs-human-decision when the worker exits 0 but opens no PR", async () => {
    const ctx = baseCtx({ findPrForBranchFn: vi.fn(() => null) });

    const [result] = await runOnce([ISSUE], ctx);

    expect(result.outcome).toBe("no-pr");
    expect(ctx.worktreeManager.statusCalls).toEqual([{ id: "MOV-1", status: "failed" }]);
    const lastComment = ctx.linearClient.calls.filter((c) => c.type === "addComment").at(-1);
    expect(lastComment.body).toMatch(/no PR was found/);
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
    expect(ctx.linearClient.calls.at(-1).body).toContain("ENOENT");
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
    const issueB = { ...ISSUE, id: "id-b", identifier: "MOV-b", labels: ["human-only"] };

    const results = await runOnce([issueA, issueB], ctx);

    expect(results.map((r) => r.outcome)).toEqual(["in-review", "blocked"]);
  });
});
