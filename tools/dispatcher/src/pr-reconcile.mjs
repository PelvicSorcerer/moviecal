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
    url: pr?.url || null,
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

/** Return whether a value has the data shape emitted by checkPrObservation. */
export function isCheckPrObservation(value) {
  if (!value || typeof value !== "object") return false;
  if (value.observationError) {
    return value.state === "UNAVAILABLE"
      && typeof value.observationError === "object"
      && typeof value.observationError.message === "string";
  }
  return typeof value.state === "string"
    && (value.headSha === null || typeof value.headSha === "string")
    && value.checks
    && typeof value.checks === "object"
    && Array.isArray(value.checks.checks)
    && Array.isArray(value.checks.required)
    && Array.isArray(value.checks.missingRequired);
}

/** Read-only GitHub CLI observer. Optional protection/review calls fail closed as observation errors. */
export function checkPrObservation(prNumber, repo, runner = defaultRunner) {
  try {
    const pr = JSON.parse(runner("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "url,state,mergedAt,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments"]));
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
 * @param {(prNumber: number, repo: string) => {state: string, mergedAt: string|null}} [ctx.checkPrStateFn]
 * @param {(prNumber: number, repo: string) => object} [ctx.observePrFn] - richer read-only observation
 * @returns {Array<{ id: string, prNumber: number, from: string, to: "merged" | "abandoned" }>}
 */
export function reconcileReviewWorktrees(worktreeManager, ctx) {
  const { ghRepo, checkPrStateFn, observePrFn } = ctx;
  const state = worktreeManager.loadState();
  const changes = [];
  const markIfReview = (id, status) => worktreeManager.markStatusIf
    ? worktreeManager.markStatusIf(id, "review", status)
    : (worktreeManager.markStatus(id, status), true);

  for (const [id, entry] of Object.entries(state)) {
    if (entry.status !== "review" || !entry.prNumber) continue;

    const pr = observePrFn ? observePrFn(entry.prNumber, ghRepo) : checkPrStateFn(entry.prNumber, ghRepo);
    if (!pr || pr.observationError) continue;
    if (pr.state === "MERGED") {
      if (markIfReview(id, "merged")) changes.push({ id, prNumber: entry.prNumber, from: "review", to: "merged" });
    } else if (pr.state === "CLOSED") {
      if (markIfReview(id, "abandoned")) changes.push({ id, prNumber: entry.prNumber, from: "review", to: "abandoned" });
    }
    // OPEN: nothing to do yet.
  }

  return changes;
}
