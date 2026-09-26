import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOnce } from "../src/run-loop.mjs";
import { worktreeName } from "../src/preflight.mjs";

vi.mock("node:child_process", async (original) => ({
  ...(await original()), execFileSync: () => { throw new Error("no live services in this fixture"); },
}));
vi.mock("../src/config.mjs", async (original) => ({
  ...(await original()), resolveIssueSpecMode: () => "off", agentSessionsEnabled: () => false,
}));
const { buildRunContext } = await import("../src/run-context.mjs");
const { WorkerTrialStore } = await import("../src/worker-trial.mjs");

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function fixture(labels) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov397-routing-"));
  roots.push(root);
  const issue = (id, routing) => ({
    id, identifier: id, title: "Routing fixture", description: "## Acceptance criteria\n- works\n## Testing Expectations\n- unit",
    labels: ["execution:mac", "model:default", ...routing], delegate: { name: "moviecal-dispatcher" },
    project: null, blockedByIds: [], stateName: "Ready for Agent",
  });
  const first = issue("MOV-397-A", ["worker:claude"]);
  const second = issue("MOV-397-B", labels);
  const snapshots = new Map([first, second].map((item) => [item.id, item]));
  const linearClient = {
    workflowStates: async () => ["Backlog", "Blocked", "Ready for Agent", "Agent Working", "Needs Human Decision", "In Review", "Done"].map((name) => ({ id: name, name })),
    issueSnapshot: async (id) => snapshots.get(id), moveToState: vi.fn(), addComment: vi.fn(),
  };
  const trial = new WorkerTrialStore({ configPath: path.join(root, "trial.json"), ledgerPath: path.join(root, "assignments.json") });
  const ctx = await buildRunContext(linearClient, "MOV", [first, second], { workerTrialStore: trial });
  const manager = {
    activeCount: () => 0, isPathFreeForIssue: () => true,
    create: vi.fn((args) => ({ ...args, path: path.join(root, args.name) })), markStatus: vi.fn(),
  };
  Object.assign(ctx, {
    concurrencyLimit: 1, logRoot: path.join(root, "logs"), worktreeManager: manager,
    stopPollIntervalMs: 0, secretPresent: () => true, issueSpecMode: "off", steeringEnabled: false,
    repositoryContextFn: () => ({}), auditWorkerResultFn: () => ({ ok: true, violations: [] }),
    writeWorkerAuditFn: () => ({}), captureVerificationEvidenceFn: () => null,
    publishWorkerResultFn: () => ({ number: 1, url: "https://github.com/owner/repo/pull/1", isDraft: true, headSha: "fixture" }),
    persistAgentSessionFn: () => {}, readAgentSessionFn: () => null,
  });
  return { ctx, first, second, snapshots, linearClient, root, trial, manager };
}

function evidence(ctx, issue) {
  return fs.readFileSync(path.join(ctx.logRoot, worktreeName(issue.identifier, issue.title), "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
}

describe("final refreshed routing through real context wiring", () => {
  it("leaves a scheduled retained-worktree resume unspent when routing changes", async () => {
    const f = await fixture(["worker:codex"]);
    f.ctx.usageLimitStore.record(f.second.identifier, {
      worker: "codex", retryAt: "2020-01-01T00:00:00.000Z",
      resume: { worktreePath: "/fixture/retained", branch: "agent/fixture", unpublishedPaths: ["src/fixture.ts"] },
    });
    f.snapshots.set(f.second.id, { ...f.second, labels: ["execution:mac", "worker:claude", "model:default"] });
    f.ctx.spawnWorkerFn = vi.fn();
    f.manager.resumeEntry = vi.fn();
    try {
      expect((await runOnce([f.second], f.ctx))[0].outcome).toBe("deferred-routing-change");
      expect(f.ctx.usageLimitStore.resumption(f.second.identifier)).not.toBeNull();
      expect(f.manager.resumeEntry).not.toHaveBeenCalled();
      expect(f.manager.create).not.toHaveBeenCalled();
      expect(f.ctx.spawnWorkerFn).not.toHaveBeenCalled();
      expect(f.linearClient.moveToState).not.toHaveBeenCalled();
    } finally { f.ctx.usageLimitStore.clear(f.second.identifier); }
  });

  it.each(["provider-binding", "quota-fallback"])("preserves unchanged worker:any routing and records its %s reason", async (reason) => {
    const f = await fixture(["worker:any"]);
    if (reason === "provider-binding") {
      f.ctx.usageLimitStore.record(f.second.identifier, { worker: "codex", retryAt: "2020-01-01T00:00:00.000Z" });
    } else {
      f.ctx.workerCooldownStore.record("claude", { resetAt: "2099-01-01T00:00:00.000Z" });
    }
    try {
      f.ctx.spawnWorkerFn = vi.fn(async ({ logDir }) => ({ exitCode: 0, logDir }));
      expect((await runOnce([f.second], f.ctx))[0].outcome).toBe("in-review");
      expect(f.ctx.spawnWorkerFn.mock.calls[0][0].invocation.command).toBe("codex");
      expect(evidence(f.ctx, f.second).at(-1)).toMatchObject({ decision: "spawn-requested", selected: { worker: "codex", reason } });
    } finally {
      f.ctx.workerCooldownStore.clear("claude");
      f.ctx.usageLimitStore.clear(f.second.identifier);
    }
  });

  it("defers a pin changed during a slot wait, then repeats the new provider's cooldown and reset-probe admission", async () => {
    const f = await fixture(["worker:claude"]);
    let release;
    let started;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    f.ctx.spawnWorkerFn = vi.fn(async ({ logDir }) => {
      started();
      await new Promise((resolve) => { release = resolve; });
      return { exitCode: 0, logDir };
    });
    const batch = runOnce([f.first, f.second], f.ctx);
    await firstStarted;
    const fresh = { ...f.second, labels: ["execution:mac", "worker:codex", "model:default"] };
    f.snapshots.set(f.second.id, fresh);
    release();
    const [, deferred] = await batch;
    expect(deferred.outcome).toBe("deferred-routing-change");
    expect(f.manager.create).toHaveBeenCalledTimes(1);
    expect(f.ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);
    expect(f.linearClient.moveToState.mock.calls.some(([id]) => id === fresh.id)).toBe(false);
    expect(evidence(f.ctx, fresh).at(-1)).toMatchObject({ decision: "deferred", selected: null });

    f.ctx.workerCooldownStore.record("codex", { resetAt: "2099-01-01T00:00:00.000Z" });
    expect((await runOnce([fresh], f.ctx))[0].outcome).toBe("deferred-worker-cooldown");
    expect(f.ctx.spawnWorkerFn).toHaveBeenCalledTimes(1);

    f.ctx.now = () => new Date("2099-01-02T00:00:00.000Z");
    f.ctx.spawnWorkerFn = vi.fn(async ({ logDir }) => ({ exitCode: 0, logDir }));
    expect((await runOnce([fresh], f.ctx))[0].outcome).toBe("in-review");
    expect(f.ctx.spawnWorkerFn.mock.calls[0][0].invocation.command).toBe("codex");
    expect(evidence(f.ctx, fresh).at(-1)).toMatchObject({ decision: "spawn-requested", selected: { worker: "codex", tier: "default" } });
  });

  it("does not charge a pending trial when worker:any refreshes to an explicit pin", async () => {
    const f = await fixture(["worker:any"]);
    f.trial.activate({ trialId: "mov397", expiresAt: new Date(Date.now() + 86400000).toISOString(), maxAssignments: 3 });
    const fresh = { ...f.second, labels: ["execution:mac", "worker:claude", "model:default"] };
    f.snapshots.set(f.second.id, fresh);
    f.ctx.spawnWorkerFn = vi.fn(async ({ logDir }) => ({ exitCode: 0, logDir }));
    expect((await runOnce([f.second], f.ctx))[0].outcome).toBe("deferred-routing-change");
    expect(f.trial.assignments()).toEqual({});
    expect(f.manager.create).not.toHaveBeenCalled();
    expect(f.ctx.spawnWorkerFn).not.toHaveBeenCalled();
    expect((await runOnce([fresh], f.ctx))[0].outcome).toBe("in-review");
    expect(f.ctx.spawnWorkerFn.mock.calls[0][0].invocation.command).toBe("claude");
    expect(f.trial.assignments()).toEqual({});
  });
});
