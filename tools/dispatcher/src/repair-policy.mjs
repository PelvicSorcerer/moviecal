// Admission control for *automatic* repair (MOV-151).
//
// MOV-148 built the classifier, MOV-145/149 built the security boundary and
// the trusted repair publication path. Everything there answers "what is this
// failure, and may this target be repaired at all?". This module answers the
// question that only matters once nobody is pressing the button: **given
// everything already tried, should the dispatcher start a repair right now,
// and of what kind?**
//
// It is pure — every input is data, every output is a decision. The stopping
// reasons are values rather than early `return`s inside the run loop, because
// "why did automation decline to act?" is the thing an operator most often
// needs to read back, and acceptance criterion 7 requires it be visible.
//
// The five refusals that carry the bounded-ness of this feature:
//
//   1. **Old SHA events** never trigger. The PR's current head is the only
//      thing repairable; a check result from two pushes ago describes code
//      that no longer exists.
//   2. **Optional checks** never trigger. Only a required check can block a
//      merge, and repairing a non-blocking failure spends real budget to no
//      end.
//   3. **Ordinary advisory comments** never trigger. A comment is not a
//      verdict; only a `REQUEST_CHANGES` review or a failing required review
//      check is.
//   4. **Untrusted reviewers** never trigger. A `REQUEST_CHANGES` is an
//      instruction to change code — the one thing prompt-injection would most
//      like to reach — so it is honoured only from a configured human.
//   5. **Sensitive and unknown failures** never trigger, and neither does an
//      exhausted budget or an already-reserved job.

import { decideCiOutcome, DEFAULT_REPAIR_BUDGETS, failureFingerprint } from "./ci-outcomes.mjs";
import { repairJobKey } from "./repair-ledger.mjs";
import { validateRepairTarget } from "./worker-guard.mjs";

const TERMINAL_CHECK_OUTCOMES = new Set(["failure", "error", "canceled", "timed-out", "unavailable-log"]);

/** A required check that reports a review verdict rather than a build result. */
const REVIEW_CHECK_RE = /review|approval/i;

/**
 * A blocking review finding that a code change must never try to satisfy by
 * itself. `lane-review`'s sensitive-path, secret-detection, and diff-size
 * blocks all fall here: the sensitive-path one is resolved by a human adding
 * the `sensitive-path-ack` label and marker (docs/operators/local-execution.md
 * §Security model), and secret/diff-size blocks are not downgradeable at all.
 * A repair worker has no authority to add either label and must not try to
 * edit its way around a governance gate.
 */
const HUMAN_ONLY_REVIEW_RE =
  /sensitive[ -]path|secret|credential|token|password|ruleset|branch protection|governance|sign-off|-ack\b|diff size|too large/i;

function text(value) {
  return String(value ?? "").trim();
}

function checkEvidence(check = {}) {
  return [check.name, check.summary, check.title, check.message, check.description, check.detailsUrl]
    .map(text)
    .filter(Boolean)
    .join(" ");
}

function reviewerLogin(review = {}) {
  return text(review.author?.login || review.author || review.user?.login || review.user || review.login);
}

/**
 * The check results that may trigger repair on this observation: required
 * checks only, current head SHA only (refusals 1 and 2 above).
 *
 * `aggregateCheckResults` already drops off-head results upstream; this
 * re-states the rule where the consequence is a worker rather than a log
 * line, and covers an observation assembled by any other path.
 */
export function selectRepairEvents(observation = {}) {
  const headSha = observation.headSha || null;
  return (observation.checks?.checks || [])
    .filter((check) => check.required === true)
    .filter((check) => !check.sha || !headSha || check.sha === headSha)
    .map((check) => ({ ...check, sha: check.sha || headSha, conclusion: check.outcome }));
}

function isFailing(check) {
  return TERMINAL_CHECK_OUTCOMES.has(check.outcome);
}

/**
 * Split an observation's triggerable events into build failures and review
 * verdicts. They are judged by different rules: a build failure is classified
 * from its log text, a review verdict from what the reviewer objected to.
 */
export function partitionRepairEvents(observation = {}) {
  const events = selectRepairEvents(observation);
  return {
    ciEvents: events.filter((check) => !REVIEW_CHECK_RE.test(text(check.name))),
    reviewChecks: events.filter((check) => REVIEW_CHECK_RE.test(text(check.name)) && isFailing(check)),
  };
}

/**
 * Judge the blocking review signals on a PR: a `REQUEST_CHANGES` review and
 * any failing required review check.
 *
 * @returns {{verdict: "repair"|"escalate"|"none", reason: string|null, events: object[], reviewers: string[]}}
 */
export function classifyReviewTrigger(observation = {}, { trustedReviewers = [] } = {}) {
  const trusted = new Set(trustedReviewers.map((login) => text(login).toLowerCase()).filter(Boolean));
  const review = observation.review || {};
  const headSha = observation.headSha || null;
  const { reviewChecks } = partitionRepairEvents(observation);

  const humanOnly = reviewChecks.filter((check) => HUMAN_ONLY_REVIEW_RE.test(checkEvidence(check)));
  if (humanOnly.length) {
    return {
      verdict: "escalate",
      reason: `blocking review finding on ${humanOnly.map((check) => text(check.name)).join(", ")} needs an explicit human sign-off, which automation must never give itself`,
      events: [],
      reviewers: [],
    };
  }

  // A `REQUEST_CHANGES` review counts only while GitHub still reports the PR
  // as blocked by it. A review that a later one superseded has a
  // `reviewDecision` that no longer says CHANGES_REQUESTED, and acting on the
  // stale body would be repairing an objection nobody is making any more.
  const outstanding = text(review.decision).toUpperCase() === "CHANGES_REQUESTED";
  const requestedChanges = outstanding ? review.requestedChanges || [] : [];
  const untrusted = requestedChanges.filter((entry) => !trusted.has(reviewerLogin(entry).toLowerCase()));
  if (untrusted.length) {
    return {
      verdict: "escalate",
      reason: `REQUEST_CHANGES from ${untrusted.map((entry) => reviewerLogin(entry) || "an unidentified reviewer").join(", ")}, who is not on the trusted-reviewer list`,
      events: [],
      reviewers: untrusted.map((entry) => reviewerLogin(entry)),
    };
  }

  const events = [];
  const reviewers = [];
  for (const entry of requestedChanges) {
    const login = reviewerLogin(entry);
    reviewers.push(login);
    events.push({
      name: `review:${login || "trusted-reviewer"}`,
      sha: headSha,
      conclusion: "failure",
      required: true,
      classification: "code-test",
      classificationReason: "trusted human REQUEST_CHANGES review",
      message: text(entry.body).slice(0, 400) || "changes requested",
    });
  }
  for (const check of reviewChecks) {
    events.push({
      ...check,
      conclusion: check.outcome,
      classification: "code-test",
      classificationReason: "machine-readable blocking review finding",
    });
  }

  if (!events.length) return { verdict: "none", reason: null, events: [], reviewers: [] };
  return {
    verdict: "repair",
    reason: reviewers.length
      ? `trusted REQUEST_CHANGES review from ${reviewers.filter(Boolean).join(", ")}`
      : `blocking required review check (${reviewChecks.map((check) => text(check.name)).join(", ")})`,
    events,
    reviewers,
  };
}

function refuse(reason, extra = {}) {
  return { action: "ignore", reason, key: null, trigger: null, fingerprints: [], decision: null, ...extra };
}

/**
 * Decide whether to start one bounded repair for a PR under observation.
 *
 * @param {object} args
 * @param {object} args.entry - the dispatcher's worktree registry entry (status "review")
 * @param {object} args.observation - checkPrObservation() result
 * @param {string} args.repository - "owner/name"
 * @param {string|null} args.localHeadSha - HEAD of the dispatcher-owned checkout
 * @param {{codeRepair: number, infrastructureRerun: number, total: number}} args.previousAttempts - from RepairLedger
 * @param {string[]} [args.reservedKeys] - job keys already reserved for this issue
 * @param {object|null} [args.unfinishedAttempt] - a reserved-but-never-completed attempt
 * @param {object} [args.budgets]
 * @param {string[]} [args.trustedReviewers]
 * @param {boolean} [args.enabled] - the MOVIECAL_AUTO_REPAIR switch
 * @returns {{action: "code-repair"|"infrastructure-rerun"|"escalate"|"ignore", reason: string, key: string|null, trigger: string|null, fingerprints: string[], decision: object|null, headSha?: string|null}}
 */
export function admitRepair({
  entry,
  observation,
  repository,
  localHeadSha = null,
  previousAttempts = { codeRepair: 0, infrastructureRerun: 0, total: 0 },
  reservedKeys = [],
  unfinishedAttempt = null,
  budgets = DEFAULT_REPAIR_BUDGETS,
  trustedReviewers = [],
  enabled = false,
} = {}) {
  if (!enabled) return refuse("automatic repair is switched off (MOVIECAL_AUTO_REPAIR)");
  if (!observation || observation.observationError) {
    return refuse(`PR could not be observed: ${observation?.observationError?.message || "no observation"}`);
  }
  if (observation.state !== "OPEN") {
    return refuse(`PR is ${text(observation.state).toLowerCase() || "not open"}; pr-reconcile.mjs owns that outcome`);
  }

  const headSha = observation.headSha || null;
  const prNumber = entry?.prNumber ?? null;
  if (!headSha || !prNumber) return refuse("observation carries no PR number or head SHA");

  const escalate = (reason, kind = "escalation", fingerprints = []) => ({
    action: "escalate",
    reason,
    key: repairJobKey({ prNumber, headSha, kind, fingerprints }),
    trigger: "guard",
    fingerprints,
    decision: null,
    headSha,
  });

  // A reserved attempt that never completed means a dispatcher died between
  // "about to start a repair" and "here is what it did". Refusing to start a
  // second worker against the same failure is the only safe reading: the
  // first one may have pushed, may have half-edited the worktree, or may have
  // done nothing, and the ledger cannot tell which.
  if (unfinishedAttempt) {
    return escalate(
      `a previous ${unfinishedAttempt.kind} attempt (${unfinishedAttempt.key}) was reserved at ${unfinishedAttempt.startedAt} and never recorded an outcome; automatic repair will not start a second worker against it`,
    );
  }

  // Provenance, fork, branch-namespace, and retained-review checks, reusing
  // MOV-145's admission control. `headSha` is deliberately taken from the
  // observation rather than from the registry entry: the entry's recorded
  // head legitimately lags across poll cycles, and it is not the property
  // worth enforcing. What *is* worth enforcing — that the checkout about to
  // be repaired is the code GitHub actually tested — is the explicit
  // comparison below, and `publishRepairResult()` re-checks it at push time.
  const target = validateRepairTarget({ entry: { ...entry, headSha }, observation, repository });
  if (!target.ok) return escalate(`repair target is not admissible: ${target.reasons.join("; ")}`);

  if (localHeadSha && localHeadSha !== headSha) {
    return escalate(
      `the dispatcher-owned checkout for ${entry.branch} is at ${localHeadSha} but the PR head is ${headSha}; automatic repair only ever edits the exact code GitHub tested`,
    );
  }

  const reviewTrigger = classifyReviewTrigger(observation, { trustedReviewers });
  if (reviewTrigger.verdict === "escalate") return escalate(reviewTrigger.reason);

  const { ciEvents } = partitionRepairEvents(observation);
  const events = [...ciEvents, ...reviewTrigger.events];
  const decision = decideCiOutcome({
    prNumber,
    prUrl: observation.url || entry?.prUrl || null,
    headSha,
    events,
    budgets,
    previousAttempts,
  });

  if (decision.action === "ignore") {
    return refuse(decision.reason, { decision, headSha });
  }

  const fingerprints = decision.failures.map((failure) => failure.fingerprint ?? failureFingerprint(failure));

  if (decision.action === "escalate") {
    return {
      action: "escalate",
      reason: decision.reason,
      key: repairJobKey({ prNumber, headSha, kind: "escalation", fingerprints }),
      trigger: reviewTrigger.verdict === "repair" ? "review" : "ci",
      fingerprints,
      decision,
      headSha,
    };
  }

  const kind = decision.action === "propose-code-repair" ? "code-repair" : "infrastructure-rerun";
  const key = repairJobKey({ prNumber, headSha, kind, fingerprints });
  if (reservedKeys.includes(key)) {
    return refuse("a repair job already exists for this head SHA and failure fingerprint", {
      key,
      decision,
      headSha,
    });
  }

  return {
    action: kind,
    reason:
      reviewTrigger.verdict === "repair" && kind === "code-repair"
        ? `${decision.reason} (${reviewTrigger.reason})`
        : decision.reason,
    key,
    trigger: reviewTrigger.verdict === "repair" ? "review" : "ci",
    fingerprints,
    decision,
    headSha,
  };
}
