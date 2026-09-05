import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "../src/worktree-manager.mjs";

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
});
