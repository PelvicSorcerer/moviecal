// Reconciles worktrees sitting in "review" status against the real state of
// their PR on GitHub, so a merged or closed-without-merging PR doesn't leave
// its worktree (and worktrees.json entry) sitting around forever.
//
// Before this existed, run-loop.mjs would move a worktree to "review" once a
// worker opened its PR, and nothing ever looked at it again — `dispatcher gc`
// only cleans up entries already marked "merged"/"failed"/"abandoned". A
// merged PR's worktree just sat there until someone noticed and cleaned it up
// by hand (see docs/planning/decision-log.md, MOV-117 cleanup).

import { execFileSync } from "node:child_process";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

/**
 * @param {number} prNumber
 * @param {string} repo - "owner/name"
 * @param {(command: string, args: string[]) => string} runner - injectable for tests; defaults to `gh`
 * @returns {{ state: "OPEN" | "MERGED" | "CLOSED", mergedAt: string | null }}
 */
export function checkPrState(prNumber, repo, runner) {
  const out = runner("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "state,mergedAt",
  ]);
  const parsed = JSON.parse(out);
  return { state: parsed.state, mergedAt: parsed.mergedAt || null };
}

/**
 * Sweep every worktree currently in "review" status that has a recorded
 * `prNumber`, check its real PR state, and react:
 *   - MERGED -> worktree marked "merged" (dispatcher gc will clean it up)
 *   - CLOSED (not merged) -> worktree marked "abandoned" (7-day retention path)
 *   - OPEN -> left alone
 *
 * Entries in "review" status with no recorded `prNumber` (e.g. from before
 * this reconciliation existed) are skipped, not errored on.
 *
 * @param {object} worktreeManager - WorktreeManager instance (or a fake)
 * @param {object} ctx
 * @param {string} ctx.ghRepo - "owner/name"
 * @param {(prNumber: number, repo: string) => {state: string, mergedAt: string|null}} ctx.checkPrStateFn
 * @returns {Array<{ id: string, prNumber: number, from: string, to: "merged" | "abandoned" }>}
 */
export function reconcileReviewWorktrees(worktreeManager, ctx) {
  const { ghRepo, checkPrStateFn } = ctx;
  const state = worktreeManager.loadState();
  const changes = [];

  for (const [id, entry] of Object.entries(state)) {
    if (entry.status !== "review" || !entry.prNumber) continue;

    const pr = checkPrStateFn(entry.prNumber, ghRepo);
    if (pr.state === "MERGED") {
      worktreeManager.markStatus(id, "merged");
      changes.push({ id, prNumber: entry.prNumber, from: "review", to: "merged" });
    } else if (pr.state === "CLOSED") {
      worktreeManager.markStatus(id, "abandoned");
      changes.push({ id, prNumber: entry.prNumber, from: "review", to: "abandoned" });
    }
    // OPEN: nothing to do yet.
  }

  return changes;
}
