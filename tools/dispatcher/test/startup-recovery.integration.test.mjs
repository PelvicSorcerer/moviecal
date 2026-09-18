import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "../src/worktree-manager.mjs";
import { reconcileStartupRecoveries } from "../src/startup-recovery.mjs";

const roots = [];
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8" });

function makeContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-startup-recovery-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  const worktrees = path.join(root, "worktrees");
  run("git", ["init", "--bare", remote], root);
  run("git", ["clone", remote, repo], root);
  run("git", ["config", "user.email", "dispatcher@example.test"], repo);
  run("git", ["config", "user.name", "Dispatcher Test"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  run("git", ["add", "README.md"], repo);
  run("git", ["commit", "-m", "base"], repo);
  run("git", ["branch", "-M", "master"], repo);
  run("git", ["push", "-u", "origin", "master"], repo);

  const manager = new WorktreeManager({
    repoRoot: repo,
    worktreeRoot: worktrees,
    statePath: path.join(root, "config", "worktrees.json"),
    runner: (command, args, opts) => run(command, args, opts.cwd),
    trustWorkspaceFn: () => ({ ok: true }),
  });
  const entry = manager.create({
    id: "MOV-1",
    name: "MOV-1-recovery",
    branch: "agent/MOV-1-recovery",
    linearIssueId: "linear-1",
  });
  manager.setWorkerPid("MOV-1", 999999);
  const calls = [];
  const linearClient = {
    moveToState: async (id, stateId) => calls.push({ type: "move", id, stateId }),
    addComment: async (id, body) => calls.push({ type: "comment", id, body }),
  };
  return { manager, entry, linearClient, calls };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function recover(ctx) {
  const changes = ctx.manager.reconcileStartup({ isPidAlive: () => false });
  await reconcileStartupRecoveries(changes, {
    worktreeManager: ctx.manager,
    linearClient: ctx.linearClient,
    readyForAgentStateId: "ready",
    needsHumanDecisionStateId: "human",
  });
}

describe("startup recovery Linear reconciliation (MOV-173)", () => {
  it("requeues a clean abandoned real Git worktree exactly once", async () => {
    const ctx = makeContext();
    await recover(ctx);
    await recover(ctx);

    expect(ctx.calls).toEqual([
      { type: "move", id: "linear-1", stateId: "ready" },
      expect.objectContaining({ type: "comment", id: "linear-1", body: expect.stringContaining("Requeuing") }),
    ]);
  });

  it("preserves a dirty real Git worktree and escalates it", async () => {
    const ctx = makeContext();
    fs.writeFileSync(path.join(ctx.entry.path, "unfinished.txt"), "do not discard\n");
    await recover(ctx);

    expect(fs.existsSync(path.join(ctx.entry.path, "unfinished.txt"))).toBe(true);
    expect(ctx.calls[0]).toEqual({ type: "move", id: "linear-1", stateId: "human" });
    expect(ctx.calls[1].body).toContain(ctx.entry.path);
  });

  it("preserves an unpushed commit and escalates it", async () => {
    const ctx = makeContext();
    fs.writeFileSync(path.join(ctx.entry.path, "committed.txt"), "still local\n");
    run("git", ["add", "committed.txt"], ctx.entry.path);
    run("git", ["commit", "-m", "local only"], ctx.entry.path);
    await recover(ctx);

    expect(ctx.calls[0]).toEqual({ type: "move", id: "linear-1", stateId: "human" });
    expect(ctx.calls[1].body).toContain("remote-tracking branch");
    expect(run("git", ["rev-list", "--count", "origin/master..HEAD"], ctx.entry.path).trim()).toBe("1");
  });

  it("kills an orphaned real worker process group before a clean worktree can be requeued (MOV-254)", async () => {
    const ctx = makeContext();
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    worker.unref();
    ctx.manager.setWorkerPid("MOV-1", worker.pid);

    const exited = new Promise((resolve) => worker.once("exit", resolve));
    const changes = ctx.manager.reconcileStartup();
    await exited;

    expect(changes).toEqual([expect.objectContaining({ id: "MOV-1", dirty: false })]);
    expect(() => process.kill(worker.pid, 0)).toThrow();
  });
});
