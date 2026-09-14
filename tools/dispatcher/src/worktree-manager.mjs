// Git worktree lifecycle management.
//
// See docs/operators/local-execution.md §Worktree lifecycle.
//
// All shell-out is done through the injectable `runner` (default: real
// child_process.execFileSync) so the orchestration logic here can be
// unit-tested against a fake runner without touching a real git repo.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { trustWorkspace as defaultTrustWorkspace } from "./claude-trust.mjs";

export class DispatcherLock {
  constructor(lockPath, { fsImpl = fs, pid = process.pid } = {}) {
    this.lockPath = lockPath;
    this.fs = fsImpl;
    this.pid = pid;
    this.owned = false;
  }

  acquire() {
    this.fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    try {
      const fd = this.fs.openSync(this.lockPath, "wx", 0o600);
      this.fs.writeFileSync(fd, JSON.stringify({ pid: this.pid, startedAt: new Date().toISOString() }) + "\n");
      this.fs.closeSync(fd);
      this.owned = true;
      return this;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = "unknown";
      try { owner = JSON.parse(this.fs.readFileSync(this.lockPath, "utf8")).pid || owner; } catch {}
      if (owner !== "unknown" && Number(owner) !== this.pid) {
        try { process.kill(Number(owner), 0); } catch (probeError) {
          if (probeError.code === "ESRCH") {
            this.fs.unlinkSync(this.lockPath);
            return this.acquire();
          }
        }
      }
      throw new Error(`dispatcher is already running (lock: ${this.lockPath}, pid: ${owner})`);
    }
  }

  release() {
    if (!this.owned) return;
    try {
      const owner = JSON.parse(this.fs.readFileSync(this.lockPath, "utf8"));
      if (Number(owner.pid) === this.pid) this.fs.unlinkSync(this.lockPath);
    } catch {}
    this.owned = false;
  }
}

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

export class WorktreeManager {
  constructor({ repoRoot, worktreeRoot, statePath, runner = defaultRunner, trustWorkspaceFn = defaultTrustWorkspace } = {}) {
    if (!repoRoot) throw new Error("repoRoot is required");
    if (!worktreeRoot) throw new Error("worktreeRoot is required");
    if (!statePath) throw new Error("statePath is required");
    this.repoRoot = repoRoot;
    this.worktreeRoot = worktreeRoot;
    this.statePath = statePath;
    this.runner = runner;
    this.trustWorkspaceFn = trustWorkspaceFn;
  }

  loadState() {
    if (!fs.existsSync(this.statePath)) return {};
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    try { return this.validateState(read(this.statePath)); } catch (primaryError) {
      try { return this.validateState(read(`${this.statePath}.bak`)); } catch {
        throw new Error(`dispatcher state is corrupt and no valid backup exists: ${primaryError.message}`);
      }
    }
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    this.validateState(state);
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tempPath, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chmodSync(tempPath, 0o600);
    if (fs.existsSync(this.statePath)) {
      try { this.validateState(JSON.parse(fs.readFileSync(this.statePath, "utf8"))); fs.copyFileSync(this.statePath, `${this.statePath}.bak`); } catch {}
    }
    fs.renameSync(tempPath, this.statePath);
    try {
      const dirFd = fs.openSync(path.dirname(this.statePath), "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {}
  }

  validateState(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("state root must be an object");
    for (const [id, entry] of Object.entries(state)) {
      if (!entry || typeof entry !== "object" || entry.id !== id) throw new Error(`invalid state entry: ${id}`);
    }
    return state;
  }

  isPathFree(worktreePath) {
    return !fs.existsSync(worktreePath);
  }

  /**
   * Like `isPathFree`, but for the one case that isn't a real concurrency
   * conflict at all (MOV-181): the path is occupied by *this same issue's*
   * own retained worktree from a prior attempt that already reached a
   * terminal status. The 7-day failed-worktree retention policy
   * (docs/operators/local-execution.md §Worktree lifecycle) exists so a
   * human can inspect a failure -- but once that same issue has been put
   * back in `Ready for Agent`, the dispatcher has no way to know retention
   * is even still wanted, and the plain path-existence check in
   * `isPathFree` blocks the very retry that was just asked for.
   *
   * Reclaims (removes the local git worktree and its local `agent/*`
   * branch only -- never the remote branch, in case a draft PR still
   * points at it) and returns true when the occupying entry is this same
   * issue, its status is terminal, and it is clean (MOV-185): no
   * uncommitted/untracked changes (`uncommittedChanges()`) and no local
   * commits missing from its remote-tracking branch. A dirty terminal
   * worktree may hold real, unrecovered work -- see the MOV-172 near-miss
   * in docs/operators/local-execution.md §Worktree lifecycle -- so it is
   * left untouched and still blocks, exactly like any other occupied path.
   * `reclaimBlockedReason()` below reports why, for a caller that wants a
   * more specific message than "worktree path already in use".
   *
   * Any other case (a different issue's worktree, an `active`/`review`
   * entry, or a path with no matching state entry at all) is unchanged
   * from `isPathFree`: still blocked.
   *
   * This performs a real side effect (an actual `git worktree remove`) and
   * must only be wired into the live dispatch path, never into a `--dry-run`
   * preview -- see run-loop.mjs's use of this vs. dispatcher.mjs's dry-run
   * command, which deliberately keeps using plain `isPathFree` so its
   * "no worktree, branch, or Linear state was changed" guarantee holds.
   *
   * Never touches `~/Library/Logs/moviecal-dispatcher/<id>/` -- that
   * directory holds the actual forensic record (stdout.log, stderr.log,
   * security-audit.json, manifest.json) and is unaffected by
   * `git worktree remove`, which only touches the worktree's own files.
   */
  isPathFreeForIssue(worktreePath, issueId) {
    const evaluation = this._evaluateReclaim(worktreePath, issueId);
    if (evaluation.status === "free") return true;
    if (evaluation.status === "reclaimable") {
      this.cleanup(issueId, { deleteRemoteBranch: false });
      return true;
    }
    return false;
  }

  /**
   * When `isPathFreeForIssue()` refuses to reclaim an otherwise-eligible
   * terminal-status worktree specifically because it is dirty (MOV-185),
   * returns a human-readable reason naming the worktree path and what kind
   * of unsaved work was found. Returns `null` for every other blocked case
   * (a different issue's worktree, an active/review entry, or an untracked
   * path) so the caller falls back to its own generic message -- those
   * cases were never at risk of the silent-data-loss this method exists to
   * name.
   */
  reclaimBlockedReason(worktreePath, issueId) {
    const evaluation = this._evaluateReclaim(worktreePath, issueId);
    return evaluation.status === "dirty" ? evaluation.reason : null;
  }

  /** Shared decision logic behind `isPathFreeForIssue()`/`reclaimBlockedReason()`. */
  _evaluateReclaim(worktreePath, issueId) {
    if (!fs.existsSync(worktreePath)) return { status: "free" };
    const entry = this.loadState()[issueId];
    const isTerminal = entry && ["failed", "abandoned", "merged"].includes(entry.status);
    if (!entry || entry.path !== worktreePath || !isTerminal) return { status: "blocked" };

    const uncommitted = this.uncommittedChanges(worktreePath);
    if (uncommitted.length > 0) {
      return {
        status: "dirty",
        reason: `worktree at ${worktreePath} for ${issueId} has uncommitted changes (${uncommitted.join(", ")}) and was not reclaimed -- see docs/operators/local-execution.md §Worktree lifecycle`,
      };
    }
    if (this.hasUnpushedCommits(worktreePath, entry.branch)) {
      return {
        status: "dirty",
        reason: `worktree at ${worktreePath} for ${issueId} has commits on ${entry.branch} not present on its remote-tracking branch and was not reclaimed -- see docs/operators/local-execution.md §Worktree lifecycle`,
      };
    }
    return { status: "reclaimable" };
  }

  /**
   * True if `branch`'s tip in `worktreePath` holds local commits missing
   * from its remote-tracking branch (MOV-185). Compares against
   * `origin/<branch>` when that ref exists locally; falls back to
   * `origin/master` -- the branch's own creation base, see `create()` --
   * when it doesn't, since a branch that was never pushed at all can still
   * hold real local commits that would otherwise be silently discarded.
   * Like `uncommittedChanges()`, this never fetches: it only compares
   * against whatever remote-tracking refs are already known locally.
   */
  hasUnpushedCommits(worktreePath, branch) {
    let baseRef = `origin/${branch}`;
    try {
      this.runner("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: worktreePath });
    } catch {
      baseRef = "origin/master";
    }
    let out;
    try {
      out = this.runner("git", ["rev-list", "--count", `${baseRef}..HEAD`], { cwd: worktreePath });
    } catch {
      return true; // can't prove it's clean -- fail closed, don't reclaim
    }
    return Number(String(out).trim()) > 0;
  }

  /**
   * The repository's main (original) checkout path, as opposed to any linked
   * worktree. Discovered via `git worktree list --porcelain`, whose first
   * `worktree <path>` line is always the main checkout. Needed because
   * Claude Code's `.claude/settings.json` trust is anchored to this path for
   * every worktree of the same repository, not to whichever worktree a
   * session happens to run from (confirmed empirically: trusting a linked
   * worktree's own path did not stop the "workspace has not been trusted"
   * warning for a `-p` session run from it; trusting the main checkout did).
   */
  mainWorktreePath() {
    const out = this.runner("git", ["worktree", "list", "--porcelain"], { cwd: this.repoRoot });
    const match = /^worktree (.+)$/m.exec(out);
    if (!match) throw new Error("could not determine main worktree path from `git worktree list --porcelain`");
    return match[1];
  }

  activeCount() {
    const state = this.loadState();
    return Object.values(state).filter((e) => e.status === "active").length;
  }

  /**
   * Paths with uncommitted changes (staged, unstaged, or untracked) in a
   * worktree, via `git status --porcelain`. Empty array = clean. Used by
   * run-loop.mjs (MOV-137) to tell a worker that abandoned its work mid-task
   * apart from one that cleanly exited with nothing left to commit.
   */
  uncommittedChanges(worktreePath) {
    const out = this.runner("git", ["status", "--porcelain"], { cwd: worktreePath });
    return out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  /**
   * Create a new worktree + branch from origin/master and record it.
   * Returns the state entry.
   */
  create({ id, name, branch, worker, model, linearUrl, linearIssueId, envLocalSource, repository }) {
    const worktreePath = path.join(this.worktreeRoot, name);
    if (!this.isPathFree(worktreePath)) {
      throw new Error(`worktree path already exists: ${worktreePath}`);
    }

    this.runner("git", ["fetch", "origin", "master"], { cwd: this.repoRoot });
    this.runner(
      "git",
      ["worktree", "add", worktreePath, "-b", branch, "origin/master"],
      { cwd: this.repoRoot },
    );

    if (envLocalSource && fs.existsSync(envLocalSource)) {
      const envLocalDest = path.join(worktreePath, ".env.local");
      fs.symlinkSync(envLocalSource, envLocalDest);
    }

    // Pre-trust both the new worktree path and the repo's main checkout path
    // in Claude Code's global config, so a headless `claude -p` worker
    // doesn't hang on the interactive workspace-trust dialog. The main
    // checkout is what actually gates .claude/settings.json loading for
    // every worktree of this repo (see mainWorktreePath() above); the
    // worktree's own path is trusted too since it's cheap and may matter for
    // other trust-scoped behavior. Safe here specifically because both paths
    // belong to this same repository the dispatcher just checked out from,
    // not an externally-supplied path. Non-fatal on failure: an untrusted
    // workspace still fails cleanly (settings.json permissions get ignored,
    // `--permission-mode dontAsk` denies the rest), which surfaces as a
    // normal worker-failure outcome rather than a hang.
    for (const pathToTrust of new Set([worktreePath, this.mainWorktreePath()])) {
      const trustResult = this.trustWorkspaceFn(pathToTrust);
      if (!trustResult.ok) {
        console.error(`Warning: could not pre-trust ${pathToTrust}: ${trustResult.reason}`);
      }
    }

    const entry = {
      id,
      name,
      branch,
      path: worktreePath,
      worker,
      model,
      linearUrl,
      // The Linear issue's internal UUID (distinct from `id`, which is the
      // human-readable identifier like "MOV-152") -- pr-reconcile.mjs needs
      // this to write back to the issue (moveToState/addComment) once the PR
      // it opened resolves, independent of GitHub's own magic-word sync.
      linearIssueId: linearIssueId || null,
      // Stored in the dispatcher-owned mode-600 registry, outside the
      // worker's worktree. Repair admission requires this provenance and the
      // live PR's same-repository/branch identity to agree (MOV-145).
      provenance: {
        executor: "moviecal-dispatcher",
        repository: repository || null,
      },
      status: "active",
      pid: process.pid,
      workerPid: null,
      startedAt: new Date().toISOString(),
    };
    const state = this.loadState();
    state[id] = entry;
    this.saveState(state);
    return entry;
  }

  /**
   * Mark a worktree entry merged/failed/abandoned/review without deleting it
   * yet. `extra` fields (e.g. `prNumber`/`prUrl` when transitioning to
   * "review") are merged into the entry so later reconciliation can look
   * the PR back up — see pr-reconcile.mjs.
   */
  markStatus(id, status, extra = {}) {
    const state = this.loadState();
    if (!state[id]) throw new Error(`no worktree record for ${id}`);
    state[id].status = status;
    state[id].endedAt = new Date().toISOString();
    Object.assign(state[id], extra);
    this.saveState(state);
    return state[id];
  }

  markStatusIf(id, expectedStatus, status, extra = {}) {
    const state = this.loadState();
    if (!state[id] || state[id].status !== expectedStatus) return null;
    state[id].status = status;
    state[id].endedAt = new Date().toISOString();
    Object.assign(state[id], extra);
    this.saveState(state);
    return state[id];
  }

  /**
   * Merge `extra` fields into an entry without touching `status`/`endedAt`.
   * Used by pr-reconcile.mjs to record bookkeeping (e.g. `linearSynced`,
   * `headSha`) after a worktree has already settled into "merged" or
   * "abandoned" -- a plain `markStatus` call would incorrectly re-stamp
   * `endedAt` and imply a fresh transition happened.
   */
  updateEntry(id, extra = {}) {
    const state = this.loadState();
    if (!state[id]) throw new Error(`no worktree record for ${id}`);
    Object.assign(state[id], extra);
    this.saveState(state);
    return state[id];
  }

  setWorkerPid(id, workerPid) {
    const state = this.loadState();
    if (!state[id]) throw new Error(`no worktree record for ${id}`);
    state[id].workerPid = workerPid || null;
    this.saveState(state);
  }

  reconcileStartup({ isPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
    const state = this.loadState();
    const changes = [];
    for (const [id, entry] of Object.entries(state)) {
      if (!["active", "review"].includes(entry.status)) continue;
      if (!fs.existsSync(entry.path)) {
        state[id].status = "abandoned";
        state[id].endedAt = new Date().toISOString();
        state[id].recoveryReason = "recorded worktree is missing after dispatcher restart";
        changes.push({ id, from: entry.status, to: "abandoned", reason: state[id].recoveryReason });
      } else if (entry.status === "review" && !entry.prNumber) {
        state[id].status = "abandoned";
        state[id].endedAt = new Date().toISOString();
        state[id].recoveryReason = "review record has no PR number after dispatcher restart";
        changes.push({ id, from: "review", to: "abandoned", reason: state[id].recoveryReason });
      } else if (entry.status === "active" && (!entry.workerPid || !isPidAlive(entry.workerPid))) {
        state[id].status = "abandoned";
        state[id].endedAt = new Date().toISOString();
        state[id].recoveryReason = "dispatcher restarted after worker stopped without a terminal update";
        changes.push({ id, from: "active", to: "abandoned", reason: state[id].recoveryReason });
      }
    }
    const knownPaths = new Set(Object.values(state).map((entry) => path.resolve(entry.path)));
    const porcelain = this.runner("git", ["worktree", "list", "--porcelain"], { cwd: this.repoRoot });
    let orphanPath = null;
    let orphanBranch = null;
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("worktree ")) orphanPath = line.slice("worktree ".length);
      if (line.startsWith("branch refs/heads/")) orphanBranch = line.slice("branch refs/heads/".length);
      if (!line && orphanPath && path.resolve(orphanPath) !== path.resolve(this.repoRoot)
        && path.relative(this.worktreeRoot, orphanPath) && !path.relative(this.worktreeRoot, orphanPath).startsWith("..")
        && !knownPaths.has(path.resolve(orphanPath))) {
        try { this.runner("git", ["worktree", "remove", "--force", orphanPath], { cwd: this.repoRoot }); } catch {}
        if (orphanBranch?.startsWith("agent/")) {
          try { this.runner("git", ["branch", "-D", orphanBranch], { cwd: this.repoRoot }); } catch {}
        }
        changes.push({ path: orphanPath, branch: orphanBranch, from: "orphaned", to: "removed" });
      }
      if (!line) { orphanPath = null; orphanBranch = null; }
    }
    if (changes.length) this.saveState(state);
    return changes;
  }

  /** Remove the worktree directory, delete the local+remote branch, and drop the record. */
  cleanup(id, { deleteRemoteBranch = true } = {}) {
    const state = this.loadState();
    const entry = state[id];
    if (!entry) throw new Error(`no worktree record for ${id}`);

    if (fs.existsSync(entry.path)) {
      this.runner("git", ["worktree", "remove", "--force", entry.path], { cwd: this.repoRoot });
    }
    try {
      this.runner("git", ["branch", "-D", entry.branch], { cwd: this.repoRoot });
    } catch {
      // local branch may already be gone; not fatal
    }
    if (deleteRemoteBranch) {
      try {
        this.runner("git", ["push", "origin", "--delete", entry.branch], { cwd: this.repoRoot });
      } catch {
        // remote branch may already be gone; not fatal
      }
    }

    delete state[id];
    this.saveState(state);
  }

  /**
   * Garbage-collect: clean up anything merged, and anything failed/abandoned
   * older than retentionDays.
   */
  gc({ retentionDays }) {
    const state = this.loadState();
    const now = Date.now();
    const removed = [];
    for (const [id, entry] of Object.entries(state)) {
      if (entry.status === "merged") {
        this.cleanup(id);
        removed.push(id);
        continue;
      }
      if (entry.status === "failed" || entry.status === "abandoned") {
        const ended = entry.endedAt ? new Date(entry.endedAt).getTime() : now;
        const ageDays = (now - ended) / (1000 * 60 * 60 * 24);
        if (ageDays >= retentionDays) {
          this.cleanup(id);
          removed.push(id);
        }
      }
    }
    return removed;
  }
}
