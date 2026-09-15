// Deterministic CI decisioning. This module is deliberately side-effect free:
// GitHub observations are inputs, and the returned decision is the only thing
// a future repair/rerun adapter should consume.

import { createHash } from "node:crypto";

/**
 * The default attempt budget for one PR's whole repair chain (MOV-151) — not
 * per head SHA, since every published repair produces a new SHA and a
 * per-SHA count would bound nothing at all.
 *
 * Two code/test repair attempts, one infrastructure rerun, three attempts in
 * total: the third repair attempt on a PR is refused and escalated. Before
 * MOV-151 these read `{codeRepair: 1, infrastructureRerun: 2}` — a
 * shadow-mode shape from when nothing acted on the decision.
 */
export const DEFAULT_REPAIR_BUDGETS = Object.freeze({
  codeRepair: 2,
  infrastructureRerun: 1,
  total: 3,
});

export const FAILURE_CLASSES = Object.freeze([
  "code-test",
  "infrastructure-transient",
  "sensitive-permission",
  "unknown",
  "non-actionable",
]);

const TERMINAL_FAILURES = new Set(["failure", "error", "canceled", "timed-out", "unavailable-log"]);
const CODE_RE = /assert|expect|test failed|failed test|vitest|playwright|xcodebuild|typescript|typecheck|compile|syntax|lint|build failed|snapshot/i;
// GitHub's `statusCheckRollup` carries a name and a conclusion for a check
// run, and no log text at all — so for most of this repo's required checks
// the *name* is the only evidence there is (MOV-151). Each of these lanes is
// definitionally a code/test lane (docs/planning/testing-lanes.md): a
// terminal failure in one means the repository's own code or tests failed.
// Without this, every real CI failure classified as `unknown` and escalated,
// which made automatic repair unreachable in practice.
const CODE_CHECK_NAME_RE = /^(?:lane-(?:baseline|unit|integration|browser|ios|real-stack|full-stack-runtime)|verify|build|typecheck|lint)\b/i;
const INFRA_RE = /timeout|timed out|rate limit|too many requests|runner|network|dns|connection|econn|registry|service unavailable|bad gateway|gateway timeout|502|503|504|cancelled by github/i;
// Widened for MOV-151: once a failing check can *start a worker* rather than
// just be reported, the governance-shaped findings `lane-review` emits have
// to land in the same "stop, a human decides" bucket as a credential error.
// A sensitive-path or ruleset finding is precisely the case where the right
// automatic action is no action.
const SENSITIVE_RE =
  /permission|forbidden|unauthori[sz]ed|\b401\b|\b403\b|credential|secret|token|oauth|access denied|authentication|sensitive[ -]path|sign-off|ruleset|branch protection|governance/i;

function text(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return text(value).toLowerCase().replace(/\s+/g, " ").replace(/[0-9a-f]{7,40}/g, "<sha>").trim();
}

function checkName(event) {
  return text(event.name || event.context || event.workflowName || event.check?.name || "unknown-check");
}

// GitHub's raw conclusions *and* `pr-reconcile.mjs`'s already-normalized
// vocabulary, mapped onto the one vocabulary TERMINAL_FAILURES speaks. Both
// halves are needed: `dispatcher shadow` feeds raw payloads in, while the
// live observation path (`checkPrObservation` -> `aggregateCheckResults`)
// feeds already-normalized ones. Before MOV-151 only the raw spellings were
// listed, so a real timed-out or cancelled required check arrived as
// `timed-out`/`canceled`, matched nothing, and was reported as
// "non-actionable" — the exact class of failure the transient-rerun path
// exists to catch.
const TERMINAL_OUTCOME_ALIASES = Object.freeze({
  failure: "failure",
  error: "error",
  cancelled: "canceled",
  canceled: "canceled",
  timed_out: "timed-out",
  "timed-out": "timed-out",
  timeout: "timed-out",
  "unavailable-log": "unavailable-log",
  unavailable_log: "unavailable-log",
});

function eventOutcome(event) {
  const conclusion = normalize(event.conclusion || event.result || event.outcome);
  const status = normalize(event.status || event.state);
  if (TERMINAL_OUTCOME_ALIASES[conclusion]) return TERMINAL_OUTCOME_ALIASES[conclusion];
  if (["success", "skipped", "neutral", "pending", "queued", "in_progress", "requested", "waiting"].includes(conclusion)) return conclusion;
  if (["pending", "queued", "in_progress", "requested", "waiting"].includes(status)) return "pending";
  if (event.logAvailable === false || event.logsAvailable === false) return "unavailable-log";
  return "non-actionable";
}

function eventMessage(event) {
  return text(event.message || event.summary || event.title || event.error || event.log || event.conclusion || event.result);
}

export function classifyFailure(event = {}) {
  const outcome = eventOutcome(event);
  const name = checkName(event);
  const message = eventMessage(event);
  if (!TERMINAL_FAILURES.has(outcome)) {
    return { classification: "non-actionable", outcome, reason: "check is not a terminal failure", check: name };
  }
  // MOV-151: a caller that classified this event from evidence this module
  // does not model may say so, and is still held to FAILURE_CLASSES. The one
  // real user is `repair-policy.mjs`, which decides blocking *review*
  // findings by review rules rather than by the CI-log regexes below —
  // "lane-review flagged an unused variable" is a code failure that reads
  // nothing like a stack trace.
  if (FAILURE_CLASSES.includes(event.classification) && event.classification !== "non-actionable") {
    return {
      classification: event.classification,
      outcome,
      reason: text(event.classificationReason) || "classified by the caller from non-CI evidence",
      check: name,
    };
  }
  const evidence = `${name} ${message}`;
  if (SENSITIVE_RE.test(evidence)) {
    return { classification: "sensitive-permission", outcome, reason: "credentials or permissions may be involved", check: name };
  }
  if (INFRA_RE.test(evidence) || outcome === "timed-out" || outcome === "canceled" || outcome === "unavailable-log") {
    return { classification: "infrastructure-transient", outcome, reason: "failure resembles a transient or unavailable CI service", check: name };
  }
  if (CODE_RE.test(evidence)) {
    return { classification: "code-test", outcome, reason: "failure points to repository code or test behavior", check: name };
  }
  if (CODE_CHECK_NAME_RE.test(name)) {
    return { classification: "code-test", outcome, reason: `${name} is a code/test lane and reported a terminal failure`, check: name };
  }
  return { classification: "unknown", outcome, reason: "failure did not match a safe automatic category", check: name };
}

export function failureFingerprint(event = {}, classified = classifyFailure(event)) {
  if (event.fingerprint) return normalize(event.fingerprint);
  const basis = [checkName(event), classified.outcome, normalize(eventMessage(event))].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 24);
}

export function idempotencyKey({ prNumber, headSha, failureFingerprint: fingerprint }) {
  if (!prNumber || !headSha || !fingerprint) throw new Error("idempotencyKey requires prNumber, headSha, and failureFingerprint");
  return `ci:${prNumber}:${headSha}:${fingerprint}`;
}

function eventIdentity(event, classified) {
  return [checkName(event).toLowerCase(), text(event.sha || event.headSha || event.oid), classified.outcome, failureFingerprint(event, classified)].join("|");
}

function budgetResult(counts, previousAttempts, budgets) {
  // A decision is one attempted repair/rerun, even when it contains several
  // failed checks. This is what makes "multiple failures on one SHA" one
  // proposed repair instead of spending the budget once per check.
  const codeUsed = (previousAttempts.codeRepair || 0) + (counts["code-test"] ? 1 : 0);
  const infraUsed = (previousAttempts.infrastructureRerun || 0) + (counts["infrastructure-transient"] ? 1 : 0);
  const previousTotal = previousAttempts.total ?? (previousAttempts.codeRepair || 0) + (previousAttempts.infrastructureRerun || 0);
  const totalUsed = previousTotal + (Object.keys(counts).length ? 1 : 0);
  return {
    codeRepair: { used: codeUsed, limit: budgets.codeRepair, available: codeUsed <= budgets.codeRepair },
    infrastructureRerun: { used: infraUsed, limit: budgets.infrastructureRerun, available: infraUsed <= budgets.infrastructureRerun },
    total: { used: totalUsed, limit: budgets.total, available: totalUsed <= budgets.total },
  };
}

/**
 * Collapse a possibly repeated, reordered, partial, or conflicting event set
 * into one auditable decision for a PR head. Conflicting terminal outcomes for
 * one check are escalated rather than guessed at.
 */
export function decideCiOutcome({ prNumber, prUrl = null, headSha, events = [], budgets: budgetOverrides = {}, previousAttempts = {} } = {}) {
  if (!prNumber || !headSha) throw new Error("decideCiOutcome requires prNumber and headSha");
  const budgets = { ...DEFAULT_REPAIR_BUDGETS, ...budgetOverrides };
  const byIdentity = new Map();
  for (const event of events) {
    const classified = classifyFailure(event);
    const identity = eventIdentity(event, classified);
    if (!byIdentity.has(identity)) byIdentity.set(identity, { ...event, ...classified, fingerprint: failureFingerprint(event, classified) });
  }
  const unique = [...byIdentity.values()].sort((a, b) => eventIdentity(a, classifyFailure(a)).localeCompare(eventIdentity(b, classifyFailure(b))));
  const byCheck = new Map();
  for (const event of unique) {
    const key = checkName(event).toLowerCase();
    const prior = byCheck.get(key) || [];
    prior.push(event);
    byCheck.set(key, prior);
  }
  const conflicts = [...byCheck.entries()].filter(([, values]) => {
    const terminal = values.filter((event) => TERMINAL_FAILURES.has(event.outcome));
    return new Set(terminal.map((event) => `${event.outcome}:${event.fingerprint}`)).size > 1;
  }).map(([check]) => check).sort();
  const failures = unique.filter((event) => event.classification !== "non-actionable");
  const counts = {};
  for (const event of failures) counts[event.classification] = (counts[event.classification] || 0) + 1;
  const attempts = budgetResult(counts, previousAttempts, budgets);
  const hasSensitiveOrUnknown = failures.some((event) => ["sensitive-permission", "unknown"].includes(event.classification));
  const hasCode = failures.some((event) => event.classification === "code-test");
  const hasInfra = failures.some((event) => event.classification === "infrastructure-transient");
  let action = "ignore";
  let reason = "no actionable failure observed";
  if (conflicts.length || hasSensitiveOrUnknown) {
    action = "escalate";
    reason = conflicts.length ? `conflicting outcomes for ${conflicts.join(", ")}` : "sensitive or unknown failure requires human review";
  } else if (hasCode && attempts.total.available && attempts.codeRepair.available) {
    action = "propose-code-repair";
    reason = "grouped code/test failures on the current head";
  } else if (hasInfra && attempts.total.available && attempts.infrastructureRerun.available && !hasCode) {
    action = "propose-infrastructure-rerun";
    reason = "recognized transient infrastructure failure";
  } else if (hasCode || hasInfra) {
    action = "escalate";
    reason = "attempt budget exhausted";
  }
  const repairKey = failures.length ? `repair:${prNumber}:${headSha}` : null;
  return {
    version: 1,
    prNumber,
    prUrl,
    headSha,
    idempotencyKeys: failures.map((event) => idempotencyKey({ prNumber, headSha, failureFingerprint: event.fingerprint })),
    repairKey,
    action,
    reason,
    classification: conflicts.length ? "unknown" : failures.length === 0 ? "non-actionable" : failures[0].classification,
    conflicts,
    failures,
    groupedFailureCount: failures.length,
    uniqueEventCount: unique.length,
    attempts,
    reconstructible: { prNumber, prUrl, headSha, requiredChecks: events.filter((event) => event.required).map(checkName) },
  };
}

export function formatShadowReport(decision) {
  return JSON.stringify({
    mode: "shadow",
    readOnly: true,
    ...decision,
    wouldStartWorker: false,
    wouldRerunCi: false,
    wouldMutateLinear: false,
  }, null, 2);
}

/** Stable human-readable Linear status, intentionally not a control command. */
export function linearObservationStatus({ decision, observation } = {}) {
  const observationKey = `ci-observation:${decision.prNumber}:${decision.headSha}`;
  const checks = observation?.requiredChecks?.length ? observation.requiredChecks.join(", ") : "none reported";
  return [
    "**CI observation (read-only)** — PR #" + decision.prNumber + ", SHA `" + decision.headSha + "`",
    ...(decision.prUrl ? [`PR: ${decision.prUrl}`] : []),
    `Decision: **${decision.action}** — ${decision.reason}.`,
    "Classification: `" + decision.classification + "`; grouped failures: " + decision.groupedFailureCount + "; required checks: " + checks + ".",
    `Attempt budget: code repair ${decision.attempts.codeRepair.used}/${decision.attempts.codeRepair.limit}, infrastructure rerun ${decision.attempts.infrastructureRerun.used}/${decision.attempts.infrastructureRerun.limit}, total ${decision.attempts.total.used}/${decision.attempts.total.limit}.`,
    "Observation key: `" + observationKey + "` (status record only; not a machine-control message).",
  ].join("\n");
}

/** Publish one concise, idempotent status record when a Linear client is supplied. */
export async function reportObservationToLinear({ linearClient, issueId, decision, observation, existingBodies = [] } = {}) {
  if (!linearClient?.addComment || !issueId) throw new Error("reportObservationToLinear requires a Linear client and issueId");
  const key = `ci-observation:${decision.prNumber}:${decision.headSha}`;
  if (existingBodies.some((body) => text(body).includes(key))) return { reported: false, reason: "already reported", key };
  await linearClient.addComment(issueId, linearObservationStatus({ decision, observation }));
  return { reported: true, key };
}
