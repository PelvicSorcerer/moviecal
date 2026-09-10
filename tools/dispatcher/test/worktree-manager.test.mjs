import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DispatcherLock, WorktreeManager } from "../src/worktree-manager.mjs";

function fakeRunner(calls, { mainWorktreePath = "/fake/main/checkout" } = {}) {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    if (command === "git" && args[0] === "worktree" && args[1] === "add") {
      fs.mkdirSync(args[2], { recursive: true });
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
      const target = args[args.length - 1];
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
      return `worktree ${mainWorktreePath}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/master\n\n`;
    }
    return "";
  };
}

describe("WorktreeManager", () => {
  let tmpRoot;
  let worktreeRoot;
  let statePath;
  let calls;
  let manager;
  let trustCalls;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-dispatcher-test-"));
    worktreeRoot = path.join(tmpRoot, "worktrees");
    statePath = path.join(tmpRoot, "config", "worktrees.json");
    calls = [];
    trustCalls = [];
    manager = new WorktreeManager({
      repoRoot: tmpRoot,
      worktreeRoot,
      statePath,
      runner: fakeRunner(calls),
      // Never touch the real ~/.claude.json from a test.
      trustWorkspaceFn: (p) => {
        trustCalls.push(p);
        return { ok: true };
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("starts with no active worktrees", () => {
    expect(manager.activeCount()).toBe(0);
  });

  it("creates a worktree, fetches origin/master first, and records it", () => {
    const entry = manager.create({
      id: "MOV-1",
      name: "MOV-1-fix-the-thing",
      branch: "agent/MOV-1-fix-the-thing",
      worker: "claude",
      model: "default",
      linearUrl: "https://linear.app/moviecal/issue/MOV-1",
    });

    expect(fs.existsSync(entry.path)).toBe(true);
    expect(manager.activeCount()).toBe(1);
    expect(calls[0]).toMatchObject({ command: "git", args: ["fetch", "origin", "master"] });
    expect(calls[1]).toMatchObject({ command: "git", args: ["worktree", "add", entry.path, "-b", "agent/MOV-1-fix-the-thing", "origin/master"] });
  });

  it("pre-trusts both the new worktree path and the repo's main checkout path", () => {
    const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    expect(new Set(trustCalls)).toEqual(new Set([entry.path, "/fake/main/checkout"]));
  });

  it("mainWorktreePath() reads the first `worktree <path>` line from git", () => {
    expect(manager.mainWorktreePath()).toBe("/fake/main/checkout");
  });

  it("mainWorktreePath() throws a clear error if git's output is unparseable", () => {
    const brokenManager = new WorktreeManager({
      repoRoot: tmpRoot,
      worktreeRoot,
      statePath,
      runner: () => "not porcelain output",
    });
    expect(() => brokenManager.mainWorktreePath()).toThrow(/could not determine main worktree path/);
  });

  it("uncommittedChanges() returns an empty array for a clean worktree (MOV-137)", () => {
    const cleanManager = new WorktreeManager({
      repoRoot: tmpRoot,
      worktreeRoot,
      statePath,
      runner: () => "",
    });
    expect(cleanManager.uncommittedChanges("/fake/worktrees/MOV-1")).toEqual([]);
  });

  it("uncommittedChanges() lists porcelain paths for a dirty worktree (MOV-137)", () => {
    let capturedArgs;
    const dirtyManager = new WorktreeManager({
      repoRoot: tmpRoot,
      worktreeRoot,
      statePath,
      runner: (command, args, opts) => {
        capturedArgs = { command, args, opts };
        return " M src/Auth.swift\n?? src/AuthTests.swift\n";
      },
    });

    expect(dirtyManager.uncommittedChanges("/fake/worktrees/MOV-1")).toEqual([
      "src/Auth.swift",
      "src/AuthTests.swift",
    ]);
    expect(capturedArgs).toMatchObject({
      command: "git",
      args: ["status", "--porcelain"],
      opts: { cwd: "/fake/worktrees/MOV-1" },
    });
  });

  it("does not fail worktree creation when pre-trusting fails (non-fatal, logged)", () => {
    const errorManager = new WorktreeManager({
      repoRoot: tmpRoot,
      worktreeRoot,
      statePath,
      runner: fakeRunner(calls),
      trustWorkspaceFn: () => ({ ok: false, reason: "could not write ~/.claude.json" }),
    });
    expect(() => errorManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" })).not.toThrow();
  });

  it("refuses to create a worktree at a path that already exists", () => {
    manager.create({ id: "MOV-1", name: "dup", branch: "agent/dup" });
    expect(() => manager.create({ id: "MOV-2", name: "dup", branch: "agent/dup-2" })).toThrow(/already exists/);
  });

  it("symlinks the shared env.local into the new worktree when a source is given", () => {
    const envSource = path.join(tmpRoot, "env.local");
    fs.writeFileSync(envSource, "NEXT_PUBLIC_SUPABASE_URL=http://example.test\n");

    const entry = manager.create({
      id: "MOV-1",
      name: "MOV-1-fix",
      branch: "agent/MOV-1-fix",
      envLocalSource: envSource,
    });

    const linked = path.join(entry.path, ".env.local");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(linked, "utf8")).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("marks a worktree merged and gc removes it", () => {
    const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    manager.markStatus("MOV-1", "merged");

    const removed = manager.gc({ retentionDays: 7 });

    expect(removed).toEqual(["MOV-1"]);
    expect(fs.existsSync(entry.path)).toBe(false);
    expect(manager.loadState()).toEqual({});
  });

  it("merges extra fields into the entry when marking status", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    manager.markStatus("MOV-1", "review", { prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" });

    const entry = manager.loadState()["MOV-1"];
    expect(entry.status).toBe("review");
    expect(entry.prNumber).toBe(42);
    expect(entry.prUrl).toBe("https://github.com/owner/repo/pull/42");
  });

  it("records the Linear issue's internal id (MOV-152), distinct from the human-readable identifier", () => {
    const entry = manager.create({
      id: "MOV-1",
      name: "MOV-1-fix",
      branch: "agent/MOV-1-fix",
      linearUrl: "https://linear.app/moviecal/issue/MOV-1",
      linearIssueId: "issue-uuid-1",
    });

    expect(entry.linearIssueId).toBe("issue-uuid-1");
    expect(manager.loadState()["MOV-1"].linearIssueId).toBe("issue-uuid-1");
  });

  it("defaults linearIssueId to null when not provided", () => {
    const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    expect(entry.linearIssueId).toBeNull();
  });

  it("records dispatcher/repository provenance outside the worker worktree for repair admission", () => {
    const entry = manager.create({
      id: "MOV-1",
      name: "MOV-1-fix",
      branch: "agent/MOV-1-fix",
      repository: "owner/repo",
    });
    expect(entry.provenance).toEqual({ executor: "moviecal-dispatcher", repository: "owner/repo" });
    expect(manager.loadState()["MOV-1"].provenance).toEqual(entry.provenance);
  });

  it("updateEntry merges fields without touching status or endedAt (MOV-152)", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    manager.markStatus("MOV-1", "merged");
    const beforeEndedAt = manager.loadState()["MOV-1"].endedAt;

    const updated = manager.updateEntry("MOV-1", { linearSynced: true });

    expect(updated.status).toBe("merged");
    expect(updated.linearSynced).toBe(true);
    expect(manager.loadState()["MOV-1"].endedAt).toBe(beforeEndedAt);
  });

  it("updateEntry throws for an unknown id", () => {
    expect(() => manager.updateEntry("MOV-404", { linearSynced: true })).toThrow(/no worktree record/);
  });

  it("keeps a recently-failed worktree until the retention window passes", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    manager.markStatus("MOV-1", "failed");

    const removed = manager.gc({ retentionDays: 7 });

    expect(removed).toEqual([]);
    expect(manager.loadState()["MOV-1"]).toBeDefined();
  });

  it("removes a failed worktree once it is older than the retention window", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    manager.markStatus("MOV-1", "failed");

    const state = manager.loadState();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    state["MOV-1"].endedAt = eightDaysAgo;
    manager.saveState(state);

    const removed = manager.gc({ retentionDays: 7 });

    expect(removed).toEqual(["MOV-1"]);
  });

  it("writes state with mode 600", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    const mode = fs.statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("uses the backup when the primary state is interrupted or corrupt", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    manager.markStatus("MOV-1", "review", { prNumber: 42 });
    fs.writeFileSync(statePath, "{\"MOV-1\":", "utf8");

    expect(manager.loadState()["MOV-1"]).toMatchObject({ id: "MOV-1", status: "active" });
  });

  it("does not silently turn an unrecoverable corrupt registry into an empty one", () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "not json", "utf8");
    expect(() => manager.loadState()).toThrow(/corrupt and no valid backup/);
  });

  it("recovers active assignments with missing workers or worktrees", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    manager.setWorkerPid("MOV-1", 1234);
    const changes = manager.reconcileStartup({ isPidAlive: () => false });
    expect(changes[0]).toMatchObject({ id: "MOV-1", from: "active", to: "abandoned" });
    expect(manager.loadState()["MOV-1"].recoveryReason).toMatch(/worker stopped/);
  });

  it("allows only one live dispatcher lock", () => {
    const lockPath = path.join(tmpRoot, "config", "dispatcher.lock");
    const first = new DispatcherLock(lockPath, { pid: process.pid });
    const second = new DispatcherLock(lockPath, { pid: process.pid + 1 });
    first.acquire();
    expect(() => second.acquire()).toThrow(/already running/);
    first.release();
    second.acquire();
    second.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
