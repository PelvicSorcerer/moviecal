// Re-admission control for resuming a retained dirty worktree after a
// provider usage-limit reset (MOV-205).
//
// `usage-limit.mjs` answers "was this a provider limit, and may one deferred
// attempt be scheduled?". This module answers the question asked much later,
// on a different poll cycle and possibly in a different dispatcher process:
// **is the thing we scheduled a resume for still the thing we would be
// resuming?**
//
// That gap is the whole reason this exists. Between the deferral and the
// reset, hours pass. A human can inspect the worktree, commit and push the
// work, delete it, check out a different branch in it, or replace it entirely;
// a `gc` pass or a crash-recovery sweep can move the registry underneath it.
// Resuming a worker into any of those is worse than not resuming at all, so
// every property that made the target safe when the resume was *scheduled* is
// re-proved here before the worker starts, from live filesystem and registry
// facts rather than from the stored plan.
//
// Same shape and same fail-closed posture as `validateRepairTarget()` in
// `worker-guard.mjs`: pure, every input is data gathered by the caller, and
// the output is the list of reasons it refused — because "why did automation
// decline to act?" is what an operator reads back. Anything unproven is a
// refusal; there is no "probably fine".
//
// Note what is deliberately *not* here: the worker safety boundary itself. A
// resumed worker is spawned through the same `spawnWorkerFn` +
// `auditWorkerResultFn` + `publishWorkerResultFn` path as any other
// implementation attempt (run-loop.mjs's `runClaimedAttempt`), so it inherits
// the Seatbelt profile, the sanitized environment, the transcript audit, and
// the trusted publication gate unchanged. Re-implementing a second, weaker
// copy of that boundary for this path is exactly the mistake to avoid.

import path from "node:path";
import { APPROVED_EXECUTOR } from "./worker-guard.mjs";

/**
 * The only registry status a scheduled resume may be admitted from.
 *
 * `failed` is what run-loop.mjs marks the retained worktree when it defers.
 * `active` would mean a worker is running in it right now, `review` that a PR
 * exists, `merged`/`abandoned` that a different lifecycle already claimed the
 * outcome — none of which a usage-limit resume may walk into.
 */
export const RESUMABLE_STATUS = "failed";

function text(value) {
  return String(value ?? "");
}

/**
 * Compare two worktree paths the way `reconcileStartup()` already does:
 * normalized, so a trailing slash or a `..` segment cannot make two names for
 * the same directory look like two different targets. An absent path never
 * matches anything, including another absent one.
 */
function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(text(a)) === path.resolve(text(b));
}

/**
 * Decide whether one scheduled retained-worktree resume may start now.
 *
 * @param {object} args
 * @param {string} args.issueId - Linear identifier, e.g. "MOV-205"
 * @param {object|null} args.plan - UsageLimitStore.resumption() result
 * @param {object|null} args.entry - this issue's live `worktrees.json` entry
 * @param {string} args.repository - the dispatcher's configured "owner/name"
 * @param {string} args.branch - the branch this issue resolves to *now*
 * @param {string} args.worktreePath - the worktree path this issue resolves to *now*
 * @param {boolean} args.dispatcherOwned - WorktreeManager.isDispatcherOwnedWorktree()
 * @param {{intact: boolean, branch: string|null, reason: string|null}} args.integrity - WorktreeManager.worktreeIntegrity()
 * @param {string[]} args.unpublishedPaths - the worktree's *current* uncommitted paths
 * @returns {{admitted: boolean, reasons: string[], reason: string|null}}
 */
export function admitUsageLimitResume({
  issueId,
  plan = null,
  entry = null,
  repository = null,
  branch = null,
  worktreePath = null,
  dispatcherOwned = false,
  integrity = null,
  unpublishedPaths = [],
} = {}) {
  const reasons = [];

  if (!plan) {
    reasons.push("no scheduled retained-worktree resume was recorded for this issue");
    return { admitted: false, reasons, reason: reasons.join("; ") };
  }

  // 1. The plan still describes the target this issue resolves to. A renamed
  //    issue title changes both the worktree name and the branch, which would
  //    silently point a "resume" at a path that was never deferred.
  if (!samePath(plan.worktreePath, worktreePath)) {
    reasons.push(
      `the recorded resume target (${plan.worktreePath || "none"}) is not this issue's current worktree path (${worktreePath || "none"})`,
    );
  }
  // Each identity below is compared only once both sides are actually
  // present. Two absent values are not a match -- "unknown equals unknown" is
  // the one comparison that must never admit anything.
  if (!text(plan.branch) || !text(branch) || plan.branch !== branch) {
    reasons.push(`the recorded resume branch (${plan.branch || "none"}) is not this issue's current branch (${branch || "none"})`);
  }
  if (!text(plan.repository) || !text(repository) || plan.repository !== repository) {
    reasons.push(
      `the resume was scheduled against repository ${plan.repository || "none"}, not this dispatcher's ${repository || "none"}`,
    );
  }
  if (!text(plan.retryAt)) {
    reasons.push("the recorded resume carries no scheduled reset time to verify the registry against");
  }

  // 2. The registry still agrees, and still describes a retained worktree
  //    rather than one some other lifecycle has since claimed.
  if (!entry) {
    reasons.push("the retained worktree has no entry in the dispatcher worktree registry");
  } else {
    if (!samePath(entry.path, worktreePath)) reasons.push(`the registry entry points at ${entry.path}, not ${worktreePath}`);
    if (entry.branch !== branch) reasons.push(`the registry entry is on branch ${entry.branch}, not ${branch}`);
    if (entry.status !== RESUMABLE_STATUS) {
      reasons.push(`the registry entry is "${entry.status}", not the retained "${RESUMABLE_STATUS}" state a resume may start from`);
    }
    // The registry's own copy of the scheduled reset, written in the same
    // transition that retained the worktree. Requiring it to match the store
    // binds the two durable records together: a resume plan that survived a
    // registry rewrite it did not cause is not a resume this dispatcher
    // scheduled.
    if (!text(entry.usageLimitResumeAt) || entry.usageLimitResumeAt !== plan.retryAt) {
      reasons.push(
        `the registry entry records a scheduled resume of ${entry.usageLimitResumeAt || "none"}, which does not match the durable record's ${plan.retryAt || "none"}`,
      );
    }
    if (entry.provenance?.executor !== APPROVED_EXECUTOR) reasons.push("the retained worktree lacks approved-executor provenance");
    if (!text(repository) || entry.provenance?.repository !== repository) {
      reasons.push("the retained worktree's provenance does not match the configured repository");
    }
  }

  // 3. The branch is still inside this dispatcher's own namespace for this
  //    issue — the same check repair admission makes, for the same reason.
  if (!text(branch).startsWith(`agent/${issueId}-`)) {
    reasons.push(`branch ${branch || "none"} is outside the dispatcher issue namespace for ${issueId}`);
  }

  // 4. Ownership, proven only by the marker `WorktreeManager.create()` stamped
  //    into the worktree's private Git directory (MOV-199) — never inferred
  //    from the path or branch, which a human-delegated worktree shares.
  if (dispatcherOwned !== true) {
    reasons.push("the worktree is not provably dispatcher-owned (no ownership marker in its private Git directory)");
  }

  // 5. It is still a real, intact Git worktree, still checked out on the
  //    branch the resume was scheduled for.
  if (!integrity || integrity.intact !== true) {
    reasons.push(integrity?.reason || "the retained worktree could not be confirmed intact");
  }

  // 6. The premise still holds. The resume exists to carry unpublished work
  //    across a provider reset; if that work is gone, somebody recovered,
  //    discarded, or replaced it, and what a resumed worker would do next is
  //    no longer a question automation should answer.
  if (!Array.isArray(unpublishedPaths) || unpublishedPaths.length === 0) {
    reasons.push(
      "the retained worktree no longer holds the unpublished changes this resume was scheduled to carry across the provider reset",
    );
  }

  return { admitted: reasons.length === 0, reasons, reason: reasons.length ? reasons.join("; ") : null };
}
