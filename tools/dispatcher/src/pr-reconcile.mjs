// Reconciles worktrees sitting in "review" status against the real state of
// their PR on GitHub, so a merged or closed-without-merging PR doesn't leave
// its worktree (and worktrees.json entry) sitting around forever.
//
// Before this existed, run-loop.mjs would move a worktree to "review" once a
// worker opened its PR, and nothing ever looked at it again — `dispatcher gc`
// only cleans up entries already marked "merged"/"failed"/"abandoned". A
// merged PR's worktree just sat there until someone noticed and cleaned it up
// by hand (see docs/planning/decision-log.md, MOV-117 cleanup).
//
// MOV-152 extends this from worktree-only bookkeeping to a Linear backstop:
// Linear's own GitHub integration is expected to move a merged PR's issue to
// Done via a magic word in the PR body (e.g. "Fixes MOV-123"), but that sync
// is external and can fail or lag. `reconcileReviewWorktrees` independently
// re-checks the Linear issue's live state and idempotently finishes the
// transition if the integration hasn't, and preserves evidence + escalates
// to a human when a PR closes without merging (which the GitHub integration
// does not resolve at all — an issue could otherwise sit in "In Review"
// forever). See docs/operators/local-execution.md §Reconciliation.

import { execFileSync } from "node:child_process";
import { COMPLETED_BLOCKER_STATE_NAMES } from "./dependency-gate.mjs";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

/** Convert GitHub's several status/check vocabulary variants to one vocabulary. */
export function normalizeCheckOutcome(check = {}) {
  const status = String(check.status || check.state || "").toLowerCase().replace(/[- ]/g, "_");
  const conclusion = String(check.conclusion || check.result || "").toLowerCase().replace(/[- ]/g, "_");
  if (conclusion === "timed_out" || conclusion === "timeout") return "timed-out";
  if (["cancelled", "canceled"].includes(conclusion)) return "canceled";
  if (conclusion === "action_required") return "failure";
  if (["success", "failure", "error", "skipped", "neutral"].includes(conclusion)) return conclusion;
  if (["queued", "pending", "in_progress", "requested", "waiting"].includes(status)) return "pending";
  if (check.logAvailable === false || check.logsAvailable === false) return "unavailable-log";
  if (["queued", "pending", "in_progress"].includes(conclusion)) return "pending";
  return "pending";
}

function checkSha(check) {
  return check.sha || check.headSha || check.oid || check.commit?.oid || check.commit?.sha || null;
}

function checkKey(check) {
  return String(check.name || check.context || check.workflowName || check.app?.name || "").trim().toLowerCase();
}

function requiredCheckKeys(requiredChecks, checks) {
  const explicit = (requiredChecks || []).map((c) => typeof c === "string" ? c : c.name || c.context).filter(Boolean);
  if (explicit.length) return new Set(explicit.map((x) => String(x).trim().toLowerCase()));
  return new Set(checks.filter((c) => c.required === true || c.isRequired === true).map(checkKey).filter(Boolean));
}

/**
 * Roll up one PR head only. The result is intentionally data-only so fixtures
 * can exercise stale, optional, out-of-order, and incomplete GitHub payloads.
 */
export function aggregateCheckResults({ headSha, checks = [], requiredChecks = [], now = Date.now(), timeoutAt = null } = {}) {
  const required = requiredCheckKeys(requiredChecks, checks);
  const current = checks.filter((check) => {
    const sha = checkSha(check);
    return !sha || !headSha || sha === headSha;
  });
  const byName = new Map();
  for (const check of current) {
    const key = checkKey(check);
    if (!key) continue;
    // A later payload is preferred; terminal results beat queued duplicates.
    const normalized = normalizeCheckOutcome(check);
    const previous = byName.get(key);
    if (!previous || (previous.outcome === "pending" && normalized !== "pending")) {
      byName.set(key, { ...check, name: check.name || check.context || key, outcome: normalized });
    }
  }
  const results = [...byName.values()].map((check) => ({
    name: check.name,
    outcome: check.outcome,
    required: required.has(checkKey(check)) || check.required === true || check.isRequired === true,
    sha: checkSha(check),
    logAvailable: check.logAvailable !== false && check.logsAvailable !== false,
    detailsUrl: check.detailsUrl || check.details_url || check.url || null,
  }));
  const requiredResults = results.filter((check) => check.required);
  const missing = [...required].filter((key) => !results.some((check) => check.required && checkKey(check) === key));
  const timedOut = timeoutAt != null && now >= new Date(timeoutAt).getTime();
  const pending = requiredResults.some((check) => check.outcome === "pending") || missing.length > 0;
  const failures = requiredResults.filter((check) => ["failure", "error", "canceled", "timed-out"].includes(check.outcome));
  const terminal = !pending || timedOut;
  return {
    headSha,
    checks: results,
    required: requiredResults,
    missingRequired: missing,
    ignoredStale: checks.filter((check) => checkSha(check) && headSha && checkSha(check) !== headSha).length,
    pending: pending && !timedOut,
    timedOut,
    terminal,
    actionable: terminal && (failures.length > 0 || missing.length > 0 || requiredResults.some((c) => c.outcome === "unavailable-log")),
    failures,
  };
}

/** Build the observation consumed by repair/review automation. No writes occur. */
export function observePullRequest({ pr, checks = [], requiredChecks = [], reviews = [], comments = [], now, timeoutAt } = {}) {
  const rollup = aggregateCheckResults({ headSha: pr?.headRefOid || pr?.headSha || null, checks, requiredChecks, now, timeoutAt });
  const requestedChanges = reviews.filter((review) => String(review.state || review.decision || "").toUpperCase() === "REQUEST_CHANGES");
  const blockingReviewChecks = rollup.required.filter((check) => /review|approval/i.test(check.name) && ["failure", "error", "canceled", "timed-out"].includes(check.outcome));
  return {
    state: pr?.state || "UNKNOWN",
    mergedAt: pr?.mergedAt || null,
    isDraft: Boolean(pr?.isDraft),
    headSha: rollup.headSha,
    mergeState: pr?.mergeStateStatus || pr?.mergeable || null,
    checks: rollup,
    review: {
      decision: pr?.reviewDecision || null,
      requestedChanges,
      blockingRequiredChecks: blockingReviewChecks,
      advisoryComments: comments.filter((comment) => !comment.required && !comment.blocking),
    },
    actionable: pr?.state === "OPEN" && !pr?.isDraft && (rollup.actionable || requestedChanges.length > 0 || blockingReviewChecks.length > 0),
  };
}

/** Read-only GitHub CLI observer. Optional protection/review calls fail closed as observation errors. */
export function checkPrObservation(prNumber, repo, runner = defaultRunner) {
  try {
    const pr = JSON.parse(runner("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "state,mergedAt,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments"]));
    let requiredChecks = [];
    try {
      const protection = JSON.parse(runner("gh", ["api", `repos/${repo}/branches/${encodeURIComponent(pr.baseRefName)}/protection/required_status_checks`]));
      requiredChecks = protection.contexts || (protection.checks || []).map((check) => check.context || check.name).filter(Boolean);
    } catch { /* Rulesets and external checks may not expose branch protection details. */ }
    return observePullRequest({ pr, checks: pr.statusCheckRollup || [], requiredChecks, reviews: pr.reviews || [], comments: pr.comments || [] });
  } catch (error) {
    return { observationError: { recoverable: true, message: error.message }, state: "UNAVAILABLE", actionable: false };
  }
}

/**
 * @param {number} prNumber
 * @param {string} repo - "owner/name"
 * @param {(command: string, args: string[]) => string} runner - injectable for tests; defaults to `gh`
 * @returns {{ state: "OPEN" | "MERGED" | "CLOSED", mergedAt: string | null }}
 */
export function checkPrState(prNumber, repo, runner = defaultRunner) {
  const out = runner("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "state,mergedAt"]);
  const parsed = JSON.parse(out);
  return { state: parsed.state, mergedAt: parsed.mergedAt || null };
}

/**
 * Idempotently ensure a merged PR's Linear issue reaches `Done`, as a
 * backstop for Linear's own GitHub magic-word sync (MOV-152). Reads the
 * issue's live state first so a sync that already happened (or a manual
 * close) is never double-written or double-commented.
 *
 * @returns {Promise<{synced: boolean, alreadyDone?: boolean, reason?: string}>}
 */
async function ensureLinearMergeSynced(entry, ctx) {
  const { linearClient, doneStateId } = ctx;
  if (!linearClient || !entry.linearIssueId) {
    return { synced: false, reason: "no linearClient/linearIssueId configured" };
  }
  const snapshot = await linearClient.issueSnapshot(entry.linearIssueId);
  if (!snapshot) return { synced: false, reason: "could not read Linear issue" };
  if (COMPLETED_BLOCKER_STATE_NAMES.has(snapshot.stateName)) {
    return { synced: true, alreadyDone: true };
  }
  if (!doneStateId) return { synced: false, reason: "no doneStateId configured" };
  await linearClient.moveToState(entry.linearIssueId, doneStateId);
  await linearClient.addComment(
    entry.linearIssueId,
    `**Dispatcher backstop:** GitHub reports PR #${entry.prNumber}${entry.prUrl ? ` (${entry.prUrl})` : ""} merged, but the issue had not yet synced to Done — moved automatically.`,
  );
  return { synced: true, alreadyDone: false };
}

/**
 * Preserve evidence and, unless the issue is already in a terminal state,
 * escalate to `Needs Human Decision` when a PR closes without merging
 * (MOV-152). A closed-unmerged PR is inherently ambiguous — abandoned,
 * superseded, or intentionally rejected — so this never guesses an outcome;
 * it only ever hands the decision to a human, or confirms one was already
 * made (issue already terminal).
 *
 * @returns {Promise<{synced: boolean, escalated?: boolean, reason?: string}>}
 */
async function escalateClosedUnmerged(entry, ctx) {
  const { linearClient, needsHumanDecisionStateId } = ctx;
  if (!linearClient || !entry.linearIssueId) {
    return { synced: false, reason: "no linearClient/linearIssueId configured" };
  }
  const snapshot = await linearClient.issueSnapshot(entry.linearIssueId);
  if (!snapshot) return { synced: false, reason: "could not read Linear issue" };

  const evidence = `**Dispatcher backstop:** PR #${entry.prNumber}${entry.prUrl ? ` (${entry.prUrl})` : ""} for branch \`${entry.branch || "unknown"}\` was closed without merging.`;
  if (COMPLETED_BLOCKER_STATE_NAMES.has(snapshot.stateName)) {
    await linearClient.addComment(entry.linearIssueId, `${evidence} Issue is already "${snapshot.stateName}" — no further action needed.`);
    return { synced: true, escalated: false };
  }
  if (!needsHumanDecisionStateId) return { synced: false, reason: "no needsHumanDecisionStateId configured" };
  await linearClient.moveToState(entry.linearIssueId, needsHumanDecisionStateId);
  await linearClient.addComment(
    entry.linearIssueId,
    `${evidence} Issue was "${snapshot.stateName}" — moved to Needs Human Decision, since a closed-unmerged PR cannot be resolved automatically.`,
  );
  return { synced: true, escalated: true };
}

/**
 * Sweep every worktree with a recorded `prNumber` and react to its real PR
 * state:
 *   - "review" entries get a fresh `gh pr view`/observation check:
 *     - MERGED -> worktree marked "merged" (dispatcher gc will clean it up)
 *     - CLOSED (not merged) -> worktree marked "abandoned" (7-day retention path)
 *     - OPEN -> left alone
 *   - "merged"/"abandoned" entries that haven't yet confirmed their Linear
 *     sync (`linearSynced` unset) are retried on every pass, independent of
 *     GitHub state, until the Linear-side write succeeds -- this is what
 *     makes the backstop survive a transient Linear API failure (MOV-152).
 *
 * When `ctx.linearClient` is supplied, a MERGED outcome idempotently ensures
 * the Linear issue reaches `Done` (`ensureLinearMergeSynced`) and a CLOSED
 * (unmerged) outcome preserves evidence and escalates to `Needs Human
 * Decision` unless the issue is already terminal (`escalateClosedUnmerged`).
 * Without a `linearClient`, only the worktree-bookkeeping half runs, same as
 * before MOV-152.
 *
 * Entries with no recorded `prNumber` (e.g. from before this reconciliation
 * existed) are skipped, not errored on.
 *
 * @param {object} worktreeManager - WorktreeManager instance (or a fake)
 * @param {object} ctx
 * @param {string} ctx.ghRepo - "owner/name"
 * @param {(prNumber: number, repo: string) => {state: string, mergedAt: string|null}} [ctx.checkPrStateFn]
 * @param {(prNumber: number, repo: string) => object} [ctx.observePrFn] - richer read-only observation
 * @param {object} [ctx.linearClient] - LinearClient instance (or a fake); omit to skip the Linear backstop entirely
 * @param {string} [ctx.doneStateId] - Linear workflow-state id for "Done"
 * @param {string} [ctx.needsHumanDecisionStateId] - Linear workflow-state id for "Needs Human Decision"
 * @returns {Promise<Array<{ id: string, prNumber: number, from: string, to: "merged" | "abandoned" }>>}
 */
export async function reconcileReviewWorktrees(worktreeManager, ctx) {
  const { ghRepo, checkPrStateFn, observePrFn, linearClient } = ctx;
  const state = worktreeManager.loadState();
  const changes = [];
  const markIfReview = (id, status, extra = {}) => worktreeManager.markStatusIf
    ? worktreeManager.markStatusIf(id, "review", status, extra)
    : (worktreeManager.markStatus(id, status, extra), true);
  const markLinearSynced = (id) => {
    if (worktreeManager.updateEntry) worktreeManager.updateEntry(id, { linearSynced: true });
  };

  for (const [id, entry] of Object.entries(state)) {
    if (!entry.prNumber) continue;

    const isFreshReview = entry.status === "review";
    const isPendingLinearRetry = ["merged", "abandoned"].includes(entry.status) && !entry.linearSynced && linearClient;
    if (!isFreshReview && !isPendingLinearRetry) continue;

    let outcomeState;
    let extra = {};
    if (isFreshReview) {
      const pr = observePrFn ? observePrFn(entry.prNumber, ghRepo) : checkPrStateFn(entry.prNumber, ghRepo);
      if (!pr || pr.observationError) continue;
      outcomeState = pr.state;
      extra = { mergedAt: pr.mergedAt ?? null, headSha: pr.headSha ?? null };
    } else {
      outcomeState = entry.status === "merged" ? "MERGED" : "CLOSED";
    }

    if (outcomeState === "MERGED") {
      if (isFreshReview) {
        if (markIfReview(id, "merged", extra)) changes.push({ id, prNumber: entry.prNumber, from: "review", to: "merged" });
      }
      if (linearClient) {
        // A Linear-side failure here (e.g. a transient API error) must not
        // abort reconciliation of every other entry in this same sweep --
        // leaving `linearSynced` unset is enough for the next poll cycle to
        // retry just this one issue.
        try {
          const result = await ensureLinearMergeSynced({ ...entry, ...extra }, ctx);
          if (result.synced) markLinearSynced(id);
        } catch { /* retried on the next reconciliation pass */ }
      }
    } else if (outcomeState === "CLOSED") {
      if (isFreshReview) {
        if (markIfReview(id, "abandoned", extra)) changes.push({ id, prNumber: entry.prNumber, from: "review", to: "abandoned" });
      }
      if (linearClient) {
        try {
          const result = await escalateClosedUnmerged({ ...entry, ...extra }, ctx);
          if (result.synced) markLinearSynced(id);
        } catch { /* retried on the next reconciliation pass */ }
      }
    }
    // OPEN: nothing to do yet.
  }

  return changes;
}
