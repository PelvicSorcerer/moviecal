import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DispatcherLock, WorktreeManager } from "../src/worktree-manager.mjs";

function fakeRunner(calls, { mainWorktreePath = "/fake/main/checkout", extraWorktrees = [] } = {}) {
  return (command, args, opts) => {
    calls.push({ command, args, opts });
    if (command === "git" && args[0] === "worktree" && args[1] === "add") {
      fs.mkdirSync(args[2], { recursive: true });
      fs.writeFileSync(path.join(args[2], ".git"), "gitdir: .fake-git-dir\n");
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
      const target = args[args.length - 1];
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
      const blocks = [`worktree ${mainWorktreePath}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/master\n`];
      for (const wt of extraWorktrees) {
        blocks.push(`worktree ${wt.path}\nHEAD 0000000000000000000000000000000000000000\n${wt.branch ? `branch refs/heads/${wt.branch}\n` : "detached\n"}`);
      }
      return blocks.join("\n") + "\n";
    }
    // Every worktree's "own Git directory" is deterministically a
    // subdirectory of itself here -- fake, but stable across repeated calls
    // with the same cwd, which is all isDispatcherOwnedWorktree()/create()
    // need: a marker written at this path is found again at the same path.
    if (command === "git" && args[0] === "rev-parse" && args.includes("--git-dir")) {
      return path.join(opts.cwd, ".fake-git-dir");
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

  describe("isPathFreeForIssue (MOV-181)", () => {
    it("a path with nothing on disk is free, same as isPathFree", () => {
      const p = path.join(worktreeRoot, "never-existed");
      expect(manager.isPathFreeForIssue(p, "MOV-1")).toBe(true);
    });

    it("reclaims the path when it's occupied by this same issue's own terminal (failed) attempt", () => {
      const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      manager.markStatus("MOV-1", "failed");
      expect(fs.existsSync(entry.path)).toBe(true); // retained, not auto-removed on failure

      expect(manager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(true);

      expect(fs.existsSync(entry.path)).toBe(false); // reclaimed
      expect(manager.loadState()["MOV-1"]).toBeUndefined(); // record dropped
      expect(calls.some((c) => c.command === "git" && c.args.join(" ") === "branch -D agent/MOV-1-fix")).toBe(true);
    });

    it("reclaims for abandoned and merged statuses too, not only failed", () => {
      for (const status of ["abandoned", "merged"]) {
        const entry = manager.create({ id: "MOV-1", name: `MOV-1-${status}`, branch: `agent/MOV-1-${status}` });
        manager.markStatus("MOV-1", status);
        expect(manager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(true);
        expect(fs.existsSync(entry.path)).toBe(false);
      }
    });

    it("never deletes the remote branch while reclaiming (a draft PR may still point at it)", () => {
      const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      manager.markStatus("MOV-1", "failed");
      manager.isPathFreeForIssue(entry.path, "MOV-1");
      expect(calls.some((c) => c.args?.[0] === "push" && c.args?.includes("--delete"))).toBe(false);
    });

    it("still blocks when the occupying entry is an active worker for the same issue -- not a stale retry", () => {
      const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      // status defaults to "active" from create()
      expect(manager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(false);
      expect(fs.existsSync(entry.path)).toBe(true); // untouched
    });

    it("still blocks when the occupying entry is a review-status worker for the same issue", () => {
      const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      manager.markStatus("MOV-1", "review", { prNumber: 1 });
      expect(manager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(false);
      expect(fs.existsSync(entry.path)).toBe(true);
    });

    it("still blocks a terminal entry belonging to a DIFFERENT issue at that path", () => {
      const entry = manager.create({ id: "MOV-1", name: "shared-name", branch: "agent/MOV-1" });
      manager.markStatus("MOV-1", "failed");
      // MOV-2 is not the occupying entry's id, even though the path exists.
      expect(manager.isPathFreeForIssue(entry.path, "MOV-2")).toBe(false);
      expect(fs.existsSync(entry.path)).toBe(true);
    });

    it("still blocks a path that exists on disk but has no matching state entry at all (untracked)", () => {
      const untracked = path.join(worktreeRoot, "untracked-dir");
      fs.mkdirSync(untracked, { recursive: true });
      expect(manager.isPathFreeForIssue(untracked, "MOV-1")).toBe(false);
      expect(fs.existsSync(untracked)).toBe(true);
    });
  });

  describe("isPathFreeForIssue dirty-worktree guard (MOV-185)", () => {
    // Like fakeRunner, but with controllable `git status --porcelain`,
    // `git rev-parse --verify` (remote-tracking ref presence), and
    // `git rev-list --count` output -- the three commands the MOV-185 dirty
    // check reads.
    function fakeDirtyRunner(calls, { porcelain = "", hasRemoteBranch = true, revListCount = "0" } = {}) {
      return (command, args, opts) => {
        calls.push({ command, args, opts });
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          fs.mkdirSync(args[2], { recursive: true });
          return "";
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
          fs.rmSync(args[args.length - 1], { recursive: true, force: true });
          return "";
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
          return `worktree /fake/main/checkout\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/master\n\n`;
        }
        if (command === "git" && args[0] === "status" && args[1] === "--porcelain") {
          return porcelain;
        }
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
          if (!hasRemoteBranch) throw new Error("fatal: needed a single revision");
          return "deadbeefcafe\n";
        }
        if (command === "git" && args[0] === "rev-list" && args[1] === "--count") {
          return revListCount;
        }
        return "";
      };
    }

    it("does not reclaim a terminal-status worktree with uncommitted changes; files remain on disk", () => {
      const dirtyCalls = [];
      const dirtyManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeDirtyRunner(dirtyCalls, { porcelain: " M src/index.js\n?? src/new-file.js\n" }),
      });
      const entry = dirtyManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      dirtyManager.markStatus("MOV-1", "failed");

      expect(dirtyManager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(false);

      expect(fs.existsSync(entry.path)).toBe(true); // untouched
      expect(dirtyManager.loadState()["MOV-1"]).toBeDefined(); // record kept
      expect(dirtyCalls.some((c) => c.args.join(" ") === "worktree remove --force " + entry.path)).toBe(false);
    });

    it("does not reclaim a terminal-status worktree with a clean tree but a commit not on its remote-tracking branch", () => {
      const dirtyCalls = [];
      const dirtyManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeDirtyRunner(dirtyCalls, { porcelain: "", hasRemoteBranch: true, revListCount: "1\n" }),
      });
      const entry = dirtyManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      dirtyManager.markStatus("MOV-1", "failed");

      expect(dirtyManager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(false);
      expect(fs.existsSync(entry.path)).toBe(true);
    });

    it("does not reclaim a clean tree with local commits never pushed anywhere (no origin/<branch> ref at all)", () => {
      const dirtyCalls = [];
      const dirtyManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeDirtyRunner(dirtyCalls, { porcelain: "", hasRemoteBranch: false, revListCount: "2\n" }),
      });
      const entry = dirtyManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      dirtyManager.markStatus("MOV-1", "failed");

      expect(dirtyManager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(false);
      expect(fs.existsSync(entry.path)).toBe(true);
    });

    it("reclaimBlockedReason names the path and cause when uncommitted changes block a reclaim", () => {
      const dirtyManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeDirtyRunner([], { porcelain: " M src/index.js\n" }),
      });
      const entry = dirtyManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      dirtyManager.markStatus("MOV-1", "failed");

      const reason = dirtyManager.reclaimBlockedReason(entry.path, "MOV-1");
      expect(reason).toContain(entry.path);
      expect(reason).toMatch(/uncommitted/);
    });

    it("reclaimBlockedReason names the path and cause when unpushed commits block a reclaim", () => {
      const dirtyManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeDirtyRunner([], { porcelain: "", revListCount: "1\n" }),
      });
      const entry = dirtyManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      dirtyManager.markStatus("MOV-1", "failed");

      const reason = dirtyManager.reclaimBlockedReason(entry.path, "MOV-1");
      expect(reason).toContain(entry.path);
      expect(reason).toMatch(/not present on its remote-tracking branch/);
    });

    it("reclaimBlockedReason returns null for a clean reclaimable worktree and for unrelated blocked cases", () => {
      const dirtyManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeDirtyRunner([]),
      });
      const entry = dirtyManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      dirtyManager.markStatus("MOV-1", "failed");
      expect(dirtyManager.reclaimBlockedReason(entry.path, "MOV-1")).toBeNull();

      const activeEntry = dirtyManager.create({ id: "MOV-2", name: "MOV-2-fix", branch: "agent/MOV-2-fix" });
      expect(dirtyManager.reclaimBlockedReason(activeEntry.path, "MOV-2")).toBeNull();
    });

    it("a clean terminal-status worktree is still reclaimed exactly as before (regression guard)", () => {
      const dirtyManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeDirtyRunner([]),
      });
      const entry = dirtyManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      dirtyManager.markStatus("MOV-1", "failed");

      expect(dirtyManager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(true);
      expect(fs.existsSync(entry.path)).toBe(false);
    });

    it("rechecks cleanliness at removal time and refuses a worktree dirtied after the initial reclaim check (MOV-201)", () => {
      let statusChecks = 0;
      const racingCalls = [];
      const racingManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: (command, args, opts) => {
          if (command === "git" && args[0] === "status" && args[1] === "--porcelain") {
            statusChecks += 1;
            return statusChecks === 1 ? "" : "?? concurrent-write.txt\n";
          }
          return fakeDirtyRunner(racingCalls)(command, args, opts);
        },
      });
      const entry = racingManager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
      racingManager.markStatus("MOV-1", "failed");

      expect(racingManager.isPathFreeForIssue(entry.path, "MOV-1")).toBe(false);
      expect(fs.existsSync(entry.path)).toBe(true);
      expect(racingManager.loadState()["MOV-1"]).toBeDefined();
      expect(racingManager.reclaimBlockedReason(entry.path, "MOV-1")).toMatch(/uncommitted changes/);
      expect(racingCalls.some((c) => c.args.join(" ") === "worktree remove --force " + entry.path)).toBe(false);
    });
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

  it("records and surfaces the iOS simulator worker-lane lease id on an abandoned entry (MOV-311)", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix", linearIssueId: "linear-1" });
    manager.setWorkerPid("MOV-1", 1234);
    manager.setIosSimLeaseId("MOV-1", "lease-abc");

    const changes = manager.reconcileStartup({ isPidAlive: () => false });

    expect(changes[0]).toMatchObject({ id: "MOV-1", iosSimLeaseId: "lease-abc" });
    expect(manager.loadState()["MOV-1"].startupRecovery).toMatchObject({ leaseReleased: false });
  });

  it("carries a null iosSimLeaseId for a non-iOS attempt", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix", linearIssueId: "linear-1" });
    manager.setWorkerPid("MOV-1", 1234);

    const changes = manager.reconcileStartup({ isPidAlive: () => false });

    expect(changes[0].iosSimLeaseId).toBeNull();
  });

  it("recovers active assignments with missing workers or worktrees", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix", linearIssueId: "linear-1" });
    manager.setWorkerPid("MOV-1", 1234);
    const changes = manager.reconcileStartup({ isPidAlive: () => false });
    expect(changes[0]).toMatchObject({ id: "MOV-1", linearIssueId: "linear-1", from: "active", to: "abandoned", dirty: false });
    expect(manager.loadState()["MOV-1"].recoveryReason).toMatch(/worker stopped/);
    expect(manager.loadState()["MOV-1"].startupRecovery).toMatchObject({ stateMoved: false, commentPosted: false });
  });

  it("terminates a recorded live worker group before requeuing its clean worktree (MOV-254)", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix", linearIssueId: "linear-1" });
    manager.setWorkerPid("MOV-1", 4321);
    const terminateWorkerProcessGroup = vi.fn(() => true);

    const changes = manager.reconcileStartup({
      isPidAlive: (pid) => pid === 4321,
      terminateWorkerProcessGroup,
    });

    expect(terminateWorkerProcessGroup).toHaveBeenCalledWith(4321);
    expect(changes[0]).toMatchObject({ id: "MOV-1", dirty: false });
  });

  it("preserves a worktree for human review when a live worker group cannot be terminated (MOV-254)", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix", linearIssueId: "linear-1" });
    manager.setWorkerPid("MOV-1", 4321);

    const changes = manager.reconcileStartup({
      isPidAlive: (pid) => pid === 4321,
      terminateWorkerProcessGroup: () => false,
    });

    expect(changes[0]).toMatchObject({ id: "MOV-1", dirty: true });
    expect(changes[0].uncommittedPaths).toContain("live worker process group could not be terminated safely");
  });

  it("preserves a worktree when the dispatcher died during the worker-pid handoff (MOV-254)", () => {
    manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix", linearIssueId: "linear-1" });
    manager.prepareWorkerSpawn("MOV-1");

    const changes = manager.reconcileStartup({ isPidAlive: () => false });

    expect(changes[0]).toMatchObject({ id: "MOV-1", dirty: true });
    expect(changes[0].uncommittedPaths).toContain("worker spawn began but no process-group leader was recorded safely");
  });

  it("recovers an active assignment whose existing path no longer resolves as a linked Git worktree (MOV-202)", () => {
    const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    manager.setWorkerPid("MOV-1", 1234);
    const probeFailingRunner = (command, args, opts) => {
      if (command === "git" && args[0] === "rev-parse" && args.includes("--git-dir") && opts?.cwd === entry.path) {
        throw new Error("not a git repository");
      }
      return fakeRunner(calls)(command, args, opts);
    };
    const probeFailingManager = new WorktreeManager({
      repoRoot: tmpRoot,
      worktreeRoot,
      statePath,
      runner: probeFailingRunner,
    });

    const changes = probeFailingManager.reconcileStartup({ isPidAlive: () => true });

    expect(changes).toEqual([expect.objectContaining({ id: "MOV-1", to: "abandoned" })]);
    expect(probeFailingManager.loadState()["MOV-1"].recoveryReason).toMatch(/no longer an intact linked Git worktree/);
  });

  it("create() stamps an ownership marker in the worktree's own Git directory", () => {
    const entry = manager.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
    expect(manager.isDispatcherOwnedWorktree(entry.path)).toBe(true);
  });

  it("isDispatcherOwnedWorktree is false for a plain directory this dispatcher never created", () => {
    const foreign = path.join(worktreeRoot, "foreign-worktree");
    fs.mkdirSync(foreign, { recursive: true });
    expect(manager.isDispatcherOwnedWorktree(foreign)).toBe(false);
  });

  describe("retained-worktree resume (MOV-205)", () => {
    /** fakeRunner plus a controllable `git rev-parse --abbrev-ref HEAD`. */
    function fakeResumeRunner(calls, { headRef = null, headThrows = false } = {}) {
      const base = fakeRunner(calls);
      return (command, args, opts) => {
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          calls.push({ command, args, opts });
          if (headThrows) throw new Error("fatal: not a git repository");
          return `${headRef ?? "HEAD"}\n`;
        }
        return base(command, args, opts);
      };
    }

    function managerWith(runnerOptions) {
      return new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeResumeRunner([], runnerOptions),
        trustWorkspaceFn: () => ({ ok: true }),
      });
    }

    describe("worktreeIntegrity", () => {
      it("confirms an existing worktree checked out on the expected branch", () => {
        const m = managerWith({ headRef: "agent/MOV-1-fix" });
        const entry = m.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });

        expect(m.worktreeIntegrity(entry.path, "agent/MOV-1-fix")).toEqual({
          intact: true,
          branch: "agent/MOV-1-fix",
          reason: null,
        });
      });

      it("refuses a path that no longer exists", () => {
        const m = managerWith({ headRef: "agent/MOV-1-fix" });
        const missing = path.join(worktreeRoot, "MOV-1-gone");

        const result = m.worktreeIntegrity(missing, "agent/MOV-1-fix");
        expect(result.intact).toBe(false);
        expect(result.reason).toContain(missing);
      });

      it("refuses a path Git can no longer read as a worktree", () => {
        const m = managerWith({ headThrows: true });
        const stranded = path.join(worktreeRoot, "MOV-1-stranded");
        fs.mkdirSync(stranded, { recursive: true });

        const result = m.worktreeIntegrity(stranded, "agent/MOV-1-fix");
        expect(result.intact).toBe(false);
        expect(result.reason).toMatch(/no longer a readable Git worktree/);
      });

      it("refuses a detached HEAD, which is never a branch this dispatcher checked out", () => {
        const m = managerWith({ headRef: "HEAD" });
        const entry = m.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });

        expect(m.worktreeIntegrity(entry.path, "agent/MOV-1-fix")).toMatchObject({
          intact: false,
          reason: expect.stringMatching(/detached HEAD/),
        });
      });

      // The case that matters most: somebody checked the retained worktree out
      // onto something else between the deferral and the reset.
      it("refuses a worktree that has moved to a different branch, and names the branch it found", () => {
        const m = managerWith({ headRef: "master" });
        const entry = m.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });

        expect(m.worktreeIntegrity(entry.path, "agent/MOV-1-fix")).toEqual({
          intact: false,
          branch: "master",
          reason: expect.stringContaining("is on master, not agent/MOV-1-fix"),
        });
      });
    });

    describe("resumeEntry", () => {
      function retained(m) {
        const entry = m.create({ id: "MOV-1", name: "MOV-1-fix", branch: "agent/MOV-1-fix" });
        m.markStatus("MOV-1", "failed", { usageLimitResumeAt: "2026-09-15T17:00:00.000Z", retainedForResume: true });
        return entry;
      }

      // Acceptance criterion: "no reclaim, new worktree, or branch deletion
      // occurs."
      it("re-opens the retained worktree in place without touching Git at all", () => {
        const calls = [];
        const m = new WorktreeManager({
          repoRoot: tmpRoot,
          worktreeRoot,
          statePath,
          runner: fakeResumeRunner(calls, { headRef: "agent/MOV-1-fix" }),
          trustWorkspaceFn: () => ({ ok: true }),
        });
        const entry = retained(m);
        const callsBefore = calls.length;

        const resumed = m.resumeEntry("MOV-1", { worktreePath: entry.path, branch: "agent/MOV-1-fix" });

        expect(resumed).toMatchObject({ status: "active", path: entry.path, branch: "agent/MOV-1-fix", resumeCount: 1 });
        expect(resumed.workerPid).toBeNull();
        expect(fs.existsSync(entry.path)).toBe(true);
        expect(calls.length).toBe(callsBefore); // no add, no remove, no branch -D, no fetch
        expect(m.loadState()["MOV-1"].status).toBe("active");
      });

      it("spends the scheduled-resume stamps so a later pass cannot read the entry as still awaiting one", () => {
        const m = managerWith({ headRef: "agent/MOV-1-fix" });
        const entry = retained(m);

        m.resumeEntry("MOV-1", { worktreePath: entry.path, branch: "agent/MOV-1-fix" });

        const stored = m.loadState()["MOV-1"];
        expect(stored.usageLimitResumeAt).toBeUndefined();
        expect(stored.retainedForResume).toBeUndefined();
        expect(stored.endedAt).toBeUndefined();
        expect(stored.resumedAt).toEqual(expect.any(String));
      });

      it("counts repeated resumes, so the registry shows how many an entry has had", () => {
        const m = managerWith({ headRef: "agent/MOV-1-fix" });
        const entry = retained(m);

        m.resumeEntry("MOV-1", { worktreePath: entry.path });
        m.markStatus("MOV-1", "failed");
        expect(m.resumeEntry("MOV-1", { worktreePath: entry.path }).resumeCount).toBe(2);
      });

      it.each([
        ["there is no record for the issue", "MOV-404", {}, /no worktree record for MOV-404/],
        ["the path does not match the record", "MOV-1", { worktreePath: "/somewhere/else" }, /points at .*, not \/somewhere\/else/],
        ["the branch does not match the record", "MOV-1", { branch: "agent/MOV-1-other" }, /is on agent\/MOV-1-fix, not agent\/MOV-1-other/],
      ])("refuses when %s", (_label, id, args, expected) => {
        const m = managerWith({ headRef: "agent/MOV-1-fix" });
        retained(m);
        expect(() => m.resumeEntry(id, args)).toThrow(expected);
      });

      it("refuses when the recorded worktree has vanished from disk", () => {
        const m = managerWith({ headRef: "agent/MOV-1-fix" });
        const entry = retained(m);
        fs.rmSync(entry.path, { recursive: true, force: true });

        expect(() => m.resumeEntry("MOV-1", { worktreePath: entry.path })).toThrow(/no longer exists/);
        expect(m.loadState()["MOV-1"].status).toBe("failed"); // registry untouched
      });
    });
  });

  describe("reconcileStartup orphan-worktree sweep (MOV-199)", () => {
    // A registry entry lost after `git worktree add` succeeded (dispatcher
    // crash, or a corrupt-state recovery that fell back to an older backup)
    // is the one case this sweep should still reclaim -- simulated here by
    // creating for real (so the ownership marker is stamped exactly as
    // production `create()` leaves it) and then deleting the registry entry
    // out from under the worktree that's still on disk.
    function dropRegistryEntry(id) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      delete state[id];
      fs.writeFileSync(statePath, JSON.stringify(state));
    }

    it("removes a dispatcher-owned orphan with no matching registry entry, when clean", () => {
      const entry = manager.create({ id: "MOV-9", name: "MOV-9-fix", branch: "agent/MOV-9-fix" });
      dropRegistryEntry("MOV-9");

      const orphanManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeRunner(calls, { extraWorktrees: [{ path: entry.path, branch: "agent/MOV-9-fix" }] }),
      });
      const changes = orphanManager.reconcileStartup();

      expect(changes).toContainEqual(
        expect.objectContaining({ path: entry.path, branch: "agent/MOV-9-fix", from: "orphaned", to: "removed" }),
      );
      expect(fs.existsSync(entry.path)).toBe(false);
    });

    it("leaves a dispatcher-owned orphan in place when it has uncommitted changes -- never force-removed", () => {
      const entry = manager.create({ id: "MOV-9", name: "MOV-9-fix", branch: "agent/MOV-9-fix" });
      dropRegistryEntry("MOV-9");
      fs.writeFileSync(path.join(entry.path, "in-progress.txt"), "not yet committed\n");

      const dirtyRunner = (command, args, opts) => {
        if (command === "git" && args[0] === "status" && args[1] === "--porcelain") return " M in-progress.txt\n";
        return fakeRunner(calls, { extraWorktrees: [{ path: entry.path, branch: "agent/MOV-9-fix" }] })(command, args, opts);
      };
      const orphanManager = new WorktreeManager({ repoRoot: tmpRoot, worktreeRoot, statePath, runner: dirtyRunner });
      const changes = orphanManager.reconcileStartup();

      expect(changes).toContainEqual(
        expect.objectContaining({
          path: entry.path,
          branch: "agent/MOV-9-fix",
          from: "orphaned",
          to: "left in place",
          reason: expect.stringMatching(/uncommitted changes/),
        }),
      );
      expect(fs.existsSync(entry.path)).toBe(true);
      expect(fs.existsSync(path.join(entry.path, "in-progress.txt"))).toBe(true);
    });

    it("leaves a dispatcher-owned orphan in place when it has commits not on its remote-tracking branch", () => {
      const entry = manager.create({ id: "MOV-9", name: "MOV-9-fix", branch: "agent/MOV-9-fix" });
      dropRegistryEntry("MOV-9");

      const unpushedRunner = (command, args, opts) => {
        if (command === "git" && args[0] === "status" && args[1] === "--porcelain") return "";
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify") return "deadbeef\n";
        if (command === "git" && args[0] === "rev-list" && args[1] === "--count") return "3\n";
        return fakeRunner(calls, { extraWorktrees: [{ path: entry.path, branch: "agent/MOV-9-fix" }] })(command, args, opts);
      };
      const orphanManager = new WorktreeManager({ repoRoot: tmpRoot, worktreeRoot, statePath, runner: unpushedRunner });
      const changes = orphanManager.reconcileStartup();

      expect(changes).toContainEqual(
        expect.objectContaining({ path: entry.path, from: "orphaned", to: "left in place", reason: expect.stringMatching(/not present on its remote-tracking branch/) }),
      );
      expect(fs.existsSync(entry.path)).toBe(true);
    });

    it("never touches a worktree this dispatcher did not create, even if unregistered (the interactive-session collision)", () => {
      // No manager.create() call at all -- this is exactly the shape of an
      // interactive/human session's own `git worktree add` landing directly
      // under the shared worktreeRoot, which is what force-deleted live
      // session work every ~30s before this fix.
      const foreign = path.join(worktreeRoot, "someone-elses-session");
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, "real-work.txt"), "important\n");

      const orphanManager = new WorktreeManager({
        repoRoot: tmpRoot,
        worktreeRoot,
        statePath,
        runner: fakeRunner(calls, { extraWorktrees: [{ path: foreign, branch: "agent/some-other-session" }] }),
      });
      const changes = orphanManager.reconcileStartup();

      expect(changes.some((c) => c.path === foreign)).toBe(false);
      expect(fs.existsSync(foreign)).toBe(true);
      expect(fs.existsSync(path.join(foreign, "real-work.txt"))).toBe(true);
    });
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
