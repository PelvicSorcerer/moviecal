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
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return {};
    }
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }

  isPathFree(worktreePath) {
    return !fs.existsSync(worktreePath);
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
   * Create a new worktree + branch from origin/master and record it.
   * Returns the state entry.
   */
  create({ id, name, branch, worker, model, linearUrl, envLocalSource }) {
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
      status: "active",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const state = this.loadState();
    state[id] = entry;
    this.saveState(state);
    return entry;
  }

  /** Mark a worktree entry merged/failed/abandoned without deleting it yet. */
  markStatus(id, status) {
    const state = this.loadState();
    if (!state[id]) throw new Error(`no worktree record for ${id}`);
    state[id].status = status;
    state[id].endedAt = new Date().toISOString();
    this.saveState(state);
    return state[id];
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
