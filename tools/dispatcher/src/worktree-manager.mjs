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

const OWNERSHIP_MARKER_FILENAME = "moviecal-dispatcher-owned.json";

/**
 * Parse `git worktree list --porcelain` into `[{ path, branch }]`. `branch`
 * is `null` for a detached-HEAD worktree.
 */
function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of String(porcelain || "").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "") {
      current = null;
    }
  }
  return entries;
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
   * Absolute path to `worktreePath`'s own per-worktree Git directory (e.g.
   * `<main>/.git/worktrees/<name>`), where `create()` stamps the ownership
   * marker `isDispatcherOwnedWorktree()` checks for. This directory is Git's
   * own private worktree metadata store -- never part of the tracked
   * working tree, so a marker written here can never show up in `git
   * status`, be committed, or collide with anything a human or another tool
   * puts inside the worktree itself.
   */
  _worktreeGitDir(worktreePath) {
    return String(
      this.runner("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: worktreePath }),
    ).trim();
  }

  /**
   * True only if `create()` itself created `worktreePath` (MOV-199).
   * Ownership is proven exclusively by the marker file `create()` stamps
   * into the worktree's own private Git directory -- never inferred from
   * the worktree's path, branch name, or presence/absence of a
   * `worktrees.json` entry. A lost or never-written registry entry (the
   * dispatcher crashing between `git worktree add` and `saveState()`) is
   * exactly the recoverable-orphan case `reconcileStartup()` exists to
   * clean up, and by definition looks identical to "not ours" from the
   * state file alone -- interactive/human sessions in this repo create
   * their own worktrees the same way, on the same `agent/**` branch
   * convention, directly under the same shared worktree root
   * (`docs/operators/local-execution.md` §Worktree lifecycle). Fails
   * closed: any error resolving the marker (including "this isn't a Git
   * worktree at all") means "not provably ours," never "assume ours."
   */
  isDispatcherOwnedWorktree(worktreePath) {
    try {
      const gitDir = this._worktreeGitDir(worktreePath);
      return fs.existsSync(path.join(gitDir, OWNERSHIP_MARKER_FILENAME));
    } catch {
      return false;
    }
  }

  /**
   * True only when a recorded path is still a linked Git worktree. A path
   * existing on disk is not enough: an interrupted or external removal can
   * leave an empty directory behind while the state registry and worker PID
   * still say it is active (MOV-202).
   *
   * Linked worktrees use a `.git` *file*, rather than a directory, which
   * points at their private Git directory. Requiring that shape before asking
   * Git to resolve it keeps an unrelated regular checkout from being accepted
   * as the dispatcher's recorded linked worktree. `rev-parse` then validates
   * that the file still resolves to usable Git metadata. Fail closed: a
   * missing, malformed, or inaccessible `.git` means the path is not intact.
   */
  isIntactLinkedWorktree(worktreePath) {
    try {
      if (!fs.lstatSync(path.join(worktreePath, ".git")).isFile()) return false;
      this._worktreeGitDir(worktreePath);
      return true;
    } catch {
      return false;
    }
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
      // cleanup() repeats the dirty checks immediately before its destructive
      // worktree removal (MOV-201). A writer may have changed the worktree
      // after _evaluateReclaim() returned above, so its return value is the
      // authoritative reclaim result.
      return this.cleanup(issueId, { deleteRemoteBranch: false });
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
   * Is `worktreePath` still a real, readable Git worktree checked out on
   * `branch` (MOV-205)?
   *
   * Asked hours after a provider usage limit retained it, immediately before
   * a resumed worker is spawned into it. `isDispatcherOwnedWorktree()` proves
   * *whose* it is; this proves it is still a worktree at all and still on the
   * branch the resume was scheduled for — a directory that was emptied, had
   * its Git metadata unlinked, or was checked out onto something else between
   * the deferral and the reset must never receive a worker.
   *
   * Fails closed in every direction: anything that cannot be read is reported
   * as not intact, with the reason, rather than assumed healthy.
   */
  worktreeIntegrity(worktreePath, branch = null) {
    if (!fs.existsSync(worktreePath)) {
      return { intact: false, branch: null, reason: `retained worktree ${worktreePath} no longer exists` };
    }
    let checkedOut;
    try {
      checkedOut = String(this.runner("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })).trim();
    } catch (error) {
      return { intact: false, branch: null, reason: `retained worktree ${worktreePath} is no longer a readable Git worktree: ${error.message}` };
    }
    // `--abbrev-ref HEAD` reports the literal string "HEAD" for a detached
    // checkout, which is never a branch this dispatcher put there.
    if (!checkedOut || checkedOut === "HEAD") {
      return { intact: false, branch: null, reason: `retained worktree ${worktreePath} is on a detached HEAD, not ${branch || "a branch"}` };
    }
    if (branch && checkedOut !== branch) {
      return { intact: false, branch: checkedOut, reason: `retained worktree ${worktreePath} is on ${checkedOut}, not ${branch}` };
    }
    return { intact: true, branch: checkedOut, reason: null };
  }

  /**
   * Re-open this issue's own retained worktree for one more worker attempt,
   * in place (MOV-205).
   *
   * The counterpart of `create()` for the one case where creating anything
   * would be the bug: a provider usage limit interrupted a worker that had
   * already produced unpublished changes, so the *existing* worktree and
   * branch are the dispatch target. Nothing here removes, recreates, fetches,
   * checks out, or otherwise touches the worktree's contents — the worker's
   * partial implementation is exactly what the resumed attempt is meant to
   * continue from. It only flips the registry entry back to `active` so the
   * normal lifecycle (concurrency accounting, crash recovery, `markStatus`)
   * applies to the resumed attempt as it would to any other.
   *
   * Admission is `admitUsageLimitResume()`'s job, not this method's; the
   * identity assertions below are a last structural backstop against being
   * called with a path or branch the caller did not actually admit.
   */
  resumeEntry(id, { worktreePath, branch } = {}) {
    const state = this.loadState();
    const entry = state[id];
    if (!entry) throw new Error(`no worktree record for ${id}`);
    if (worktreePath && entry.path !== worktreePath) {
      throw new Error(`worktree record for ${id} points at ${entry.path}, not ${worktreePath}`);
    }
    if (branch && entry.branch !== branch) {
      throw new Error(`worktree record for ${id} is on ${entry.branch}, not ${branch}`);
    }
    if (!fs.existsSync(entry.path)) throw new Error(`retained worktree for ${id} no longer exists at ${entry.path}`);

    entry.status = "active";
    entry.pid = process.pid;
    entry.workerPid = null;
    entry.resumedAt = new Date().toISOString();
    entry.resumeCount = (entry.resumeCount || 0) + 1;
    // The scheduled resume is being spent right now; leaving these behind
    // would let a later pass read this entry as still awaiting one.
    delete entry.endedAt;
    // These stamps exist only on the usage-limit path. Keeping the cleanup
    // conditional makes a direct/manual resume auditable rather than implying
    // it consumed a scheduled usage-limit resume that was never present.
    if (Object.hasOwn(entry, "usageLimitResumeAt")) delete entry.usageLimitResumeAt;
    if (Object.hasOwn(entry, "retainedForResume")) delete entry.retainedForResume;
    this.saveState(state);
    return entry;
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

    // Stamp ownership into the worktree's own private Git directory, not the
    // tracked working tree, so reconcileStartup()'s orphan sweep can prove
    // this dispatcher created it even if the worktrees.json entry above is
    // later lost -- and, symmetrically, never mistake a worktree it did not
    // create for one of its own (MOV-199). Deliberately last: every step
    // above either already succeeded or this function would have thrown
    // before reaching here, so there is no window where a marker exists for
    // a worktree whose creation did not fully complete.
    try {
      const gitDir = this._worktreeGitDir(worktreePath);
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(
        path.join(gitDir, OWNERSHIP_MARKER_FILENAME),
        JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2) + "\n",
      );
    } catch (err) {
      console.error(`Warning: could not stamp ownership marker for ${worktreePath}: ${err.message}`);
    }

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

  markStartupRecoveryProgress(id, extra = {}) {
    const state = this.loadState();
    if (!state[id]?.startupRecovery) return null;
    Object.assign(state[id].startupRecovery, extra);
    this.saveState(state);
    return state[id];
  }

  _startupRecoveryChange(id, entry) {
    const recovery = entry.startupRecovery;
    return {
      id,
      linearIssueId: entry.linearIssueId || null,
      path: entry.path,
      from: recovery.from,
      to: "abandoned",
      reason: recovery.reason,
      dirty: recovery.dirty,
      uncommittedPaths: recovery.uncommittedPaths || [],
      hasUnpushedCommits: Boolean(recovery.hasUnpushedCommits),
    };
  }

  _abandonForStartupRecovery(state, id, entry, reason) {
    const from = entry.status;
    let uncommittedPaths = [];
    let hasUnpushedCommits = false;
    // A missing worktree has nothing left to preserve. For an existing one,
    // fail closed: an inspection error means human review, never requeue.
    if (fs.existsSync(entry.path)) {
      try {
        uncommittedPaths = this.uncommittedChanges(entry.path);
        hasUnpushedCommits = this.hasUnpushedCommits(entry.path, entry.branch);
      } catch {
        uncommittedPaths = ["unable to inspect worktree safely"];
      }
    }
    state[id].status = "abandoned";
    state[id].endedAt = new Date().toISOString();
    state[id].recoveryReason = reason;
    // Persist each Linear effect independently so an interrupted recovery
    // resumes this exact abandonment without duplicate completed writes.
    state[id].startupRecovery = {
      from,
      reason,
      dirty: uncommittedPaths.length > 0 || hasUnpushedCommits,
      uncommittedPaths,
      hasUnpushedCommits,
      stateMoved: false,
      commentPosted: false,
    };
    return this._startupRecoveryChange(id, state[id]);
  }

  reconcileStartup({ isPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
    const state = this.loadState();
    const changes = [];
    for (const [id, entry] of Object.entries(state)) {
      if (entry.status === "abandoned" && entry.startupRecovery && !entry.startupRecovery.commentPosted) {
        changes.push(this._startupRecoveryChange(id, entry));
        continue;
      }
      if (!["active", "review"].includes(entry.status)) continue;
      if (!fs.existsSync(entry.path) || !this.isIntactLinkedWorktree(entry.path)) {
        const reason = fs.existsSync(entry.path)
          ? "recorded worktree is no longer an intact linked Git worktree after dispatcher restart"
          : "recorded worktree is missing after dispatcher restart";
        changes.push(this._abandonForStartupRecovery(state, id, entry, reason));
      } else if (entry.status === "review" && !entry.prNumber) {
        changes.push(this._abandonForStartupRecovery(state, id, entry, "review record has no PR number after dispatcher restart"));
      } else if (entry.status === "active" && (!entry.workerPid || !isPidAlive(entry.workerPid))) {
        changes.push(this._abandonForStartupRecovery(state, id, entry, "dispatcher restarted after worker stopped without a terminal update"));
      }
    }
    const knownPaths = new Set(Object.values(state).map((entry) => path.resolve(entry.path)));
    const porcelain = this.runner("git", ["worktree", "list", "--porcelain"], { cwd: this.repoRoot });
    const candidates = parseWorktreeList(porcelain).filter((entry) => {
      const resolved = path.resolve(entry.path);
      if (resolved === path.resolve(this.repoRoot)) return false;
      const relative = path.relative(this.worktreeRoot, entry.path);
      if (!relative || relative.startsWith("..")) return false; // not under our configured worktree root
      return !knownPaths.has(resolved);
    });
    for (const { path: candidatePath, branch: candidateBranch } of candidates) {
      // Never a candidate at all unless this dispatcher provably created it
      // (MOV-199) -- see isDispatcherOwnedWorktree() for why that can't be
      // inferred from the path, branch, or the missing registry entry alone.
      if (!this.isDispatcherOwnedWorktree(candidatePath)) continue;

      const uncommitted = this.uncommittedChanges(candidatePath);
      const unpushed = candidateBranch ? this.hasUnpushedCommits(candidatePath, candidateBranch) : false;
      if (uncommitted.length > 0 || unpushed) {
        // Dirty, unregistered, but genuinely ours: same "never silently
        // discard real work" guarantee MOV-185 gave the same-issue reclaim
        // path. Left in place for a human to triage.
        const reason = uncommitted.length > 0
          ? `has uncommitted changes (${uncommitted.join(", ")})`
          : `has commits on ${candidateBranch} not present on its remote-tracking branch`;
        changes.push({
          path: candidatePath,
          branch: candidateBranch,
          from: "orphaned",
          to: "left in place",
          reason: `${reason} -- see docs/operators/local-execution.md §Worktree lifecycle`,
        });
        continue;
      }

      try { this.runner("git", ["worktree", "remove", "--force", candidatePath], { cwd: this.repoRoot }); } catch {}
      if (candidateBranch?.startsWith("agent/")) {
        try { this.runner("git", ["branch", "-D", candidateBranch], { cwd: this.repoRoot }); } catch {}
      }
      changes.push({
        path: candidatePath,
        branch: candidateBranch,
        from: "orphaned",
        to: "removed",
        reason: "dispatcher-owned worktree with no matching worktrees.json entry, and clean",
      });
    }
    if (changes.length) this.saveState(state);
    return changes;
  }

  /**
   * Remove the worktree directory, delete the local+remote branch, and drop
   * the record. Returns false without changing anything when the worktree is
   * no longer clean at the final pre-removal check.
   */
  cleanup(id, { deleteRemoteBranch = true } = {}) {
    const state = this.loadState();
    const entry = state[id];
    if (!entry) throw new Error(`no worktree record for ${id}`);

    if (fs.existsSync(entry.path)) {
      // Do not rely on a clean check made by a caller before it invoked
      // cleanup(): a concurrent worker/editor can write between that check
      // and `git worktree remove --force`. Check again at the destructive
      // boundary and leave both the worktree and registry record intact if
      // either form of recoverable work appeared (MOV-201).
      if (this.uncommittedChanges(entry.path).length > 0 || this.hasUnpushedCommits(entry.path, entry.branch)) {
        return false;
      }
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
    return true;
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
        if (this.cleanup(id)) removed.push(id);
        continue;
      }
      if (entry.status === "failed" || entry.status === "abandoned") {
        const ended = entry.endedAt ? new Date(entry.endedAt).getTime() : now;
        const ageDays = (now - ended) / (1000 * 60 * 60 * 24);
        if (ageDays >= retentionDays) {
          if (this.cleanup(id)) removed.push(id);
        }
      }
    }
    return removed;
  }
}
