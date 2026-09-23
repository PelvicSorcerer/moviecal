// Post-merge master-failure policy (MOV-305).
//
// MOV-301/MOV-302 close the ordinary *pre*-merge gate: relevant PRs report
// `lane-ios`, and `master-protection` requires it. A workflow run on `master`
// can still fail afterwards — a merge-only interaction, a runner outage, or a
// defect an earlier run missed. Before this module, the dispatcher could only
// observe and boundedly repair **open, dispatcher-owned PRs**; once a PR
// merged, its review worktree stopped being an eligible repair target and the
// red master lane had no durable owner at all.
//
// This module is the decision half of the answer, and it is deliberately
// pure: GitHub facts in, one auditable decision out. No `gh`, no Linear, no
// filesystem. Everything it can decide is therefore unit-testable against a
// plain object, and the two effectful halves (master-ci-github.mjs,
// master-ci-observer.mjs) have nothing to decide of their own.
//
// The one invariant that outranks every convenience here: **no decision this
// module can produce is an action on `master`.** The single non-escalating
// outcome is `route-fix-pr`, which files a fully specced remediation issue for
// the ordinary promote → dispatch → draft-PR pipeline. There is no repair,
// no rerun, no revert, and no push target anywhere in this file — a direct
// master action is not a refused branch, it is an unrepresentable one.

import { classifyFailure } from "./ci-outcomes.mjs";

export const MASTER_BRANCH = "master";

/**
 * The workflows whose `push`-to-`master` runs are treated as verification.
 *
 * `review-verify` is `pull_request`-only and `smoke-*` are scheduled/manual,
 * so none of them can produce a master push run in the first place; listing
 * only the four that can keeps "a new scheduled workflow started failing" out
 * of the incident path by construction rather than by a later filter.
 */
export const DEFAULT_MASTER_VERIFICATION_WORKFLOWS = Object.freeze([
  "verify",
  "ios-verify",
  "browser-verify",
  "supabase-verify",
]);

/** Run conclusions that are a master *failure*. Everything else is not an incident. */
const FAILING_RUN_CONCLUSIONS = new Set(["failure", "timed_out", "timed-out", "startup_failure"]);

/**
 * Terminal conclusions that are explicitly **not** incidents, listed rather
 * than defaulted so the refusal reason can name which one it saw.
 * `cancelled` is here on purpose (acceptance criterion 2): a cancelled run
 * says something about the person or automation that cancelled it, not about
 * `master`.
 */
const NON_INCIDENT_CONCLUSIONS = new Set([
  "success",
  "skipped",
  "neutral",
  "cancelled",
  "canceled",
  "stale",
  "action_required",
]);

/**
 * Job names that must never be repaired automatically, no matter how their
 * failure reads. `lane-migrate-prod` runs a production database migration;
 * `lane-smoke-post-deploy` observes production. "Anything adding a new
 * secret", "any production deploy", and "database migrations touching
 * existing tables" are already unconditional `Needs Human Decision` items
 * (docs/operators/local-execution.md §Security model), and a post-merge
 * observer is not a new exception to that list.
 *
 * Deliberately applied here rather than in `ci-outcomes.mjs`: widening the
 * shared classifier would change the existing open-PR repair path, which this
 * issue must leave untouched.
 */
const HUMAN_ONLY_JOB_RE = /migrate|deploy|release|prod\b|production|secret|credential|token/i;

/** `Linear: MOV-123` / `Fixes MOV-123` — the only source-issue reference read. */
const LINEAR_REFERENCE_RE = /\b(?:MOV-\d+)\b/gi;

function text(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

/**
 * Accept either shape GitHub hands back: `gh run view --json` (camelCase) or
 * the REST `actions/runs` payload (snake_case). One normalized record means
 * the eligibility rules below are written once, and a caller that switches
 * transports cannot silently start reading `undefined` for `event`.
 *
 * It is also **idempotent**: normalizing an already-normalized record returns
 * the same record. The observer merges a list entry with its detail read and
 * re-checks eligibility on the result, so a non-idempotent normalizer would
 * quietly drop the run id on the second pass and report every real incident
 * as ineligible.
 */
export function normalizeMasterRun(raw = {}) {
  const repositoryName = raw.repository?.full_name ?? raw.repository?.nameWithOwner ?? raw.repository ?? null;
  const headRepositoryName =
    raw.head_repository?.full_name ?? raw.headRepository?.nameWithOwner ?? raw.headRepository ?? null;
  return {
    runId: raw.databaseId ?? raw.id ?? raw.runId ?? null,
    runAttempt: Number(raw.attempt ?? raw.run_attempt ?? raw.runAttempt ?? 1) || 1,
    runNumber: raw.number ?? raw.run_number ?? raw.runNumber ?? null,
    workflowName: text(raw.workflowName ?? raw.name ?? raw.workflow_name) || null,
    event: lower(raw.event),
    status: lower(raw.status),
    conclusion: lower(raw.conclusion),
    headBranch: text(raw.headBranch ?? raw.head_branch) || null,
    headSha: text(raw.headSha ?? raw.head_sha) || null,
    url: text(raw.url ?? raw.html_url) || null,
    createdAt: text(raw.createdAt ?? raw.created_at) || null,
    updatedAt: text(raw.updatedAt ?? raw.updated_at) || null,
    repository: repositoryName ? text(repositoryName) : null,
    headRepository: headRepositoryName ? text(headRepositoryName) : null,
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
  };
}

/**
 * Is this completed run a master incident candidate at all?
 *
 * Every clause is a refusal with a named reason rather than a silent `false`,
 * because "why was this run not treated as an incident?" is the question an
 * operator asks first when one is missing.
 *
 * @returns {{eligible: boolean, reason: string, run: object}}
 */
export function masterRunEligibility(rawRun = {}, { repo = null, workflows = DEFAULT_MASTER_VERIFICATION_WORKFLOWS } = {}) {
  const run = normalizeMasterRun(rawRun);
  const no = (reason) => ({ eligible: false, reason, run });

  if (!run.runId) return no("run has no immutable run id");
  if (run.event !== "push") return no(`event is "${run.event || "unknown"}", not a push to ${MASTER_BRANCH}`);
  if (run.headBranch !== MASTER_BRANCH) return no(`branch is "${run.headBranch || "unknown"}", not ${MASTER_BRANCH}`);
  if (run.status !== "completed") return no(`run is "${run.status || "unknown"}", not completed`);
  if (!run.headSha) return no("run reports no tested commit SHA");
  // A fork can never produce a push run on this repository's `master`, but an
  // observation assembled from a payload that *does* carry both repositories
  // is checked anyway: failing closed on a mismatch costs nothing, and the
  // alternative is trusting that the transport never changes.
  if (repo && run.headRepository && run.headRepository !== repo) {
    return no(`run head repository is ${run.headRepository}, not ${repo}`);
  }
  if (repo && run.repository && run.repository !== repo) {
    return no(`run repository is ${run.repository}, not ${repo}`);
  }
  const configured = (workflows || []).map(lower).filter(Boolean);
  if (configured.length && !configured.includes(lower(run.workflowName))) {
    return no(`workflow "${run.workflowName || "unknown"}" is not a configured master verification workflow`);
  }
  if (NON_INCIDENT_CONCLUSIONS.has(run.conclusion)) {
    return no(`conclusion is "${run.conclusion}", which is not a master failure`);
  }
  if (!FAILING_RUN_CONCLUSIONS.has(run.conclusion)) {
    return no(`conclusion is "${run.conclusion || "unknown"}", which is not a recognized terminal failure`);
  }
  return { eligible: true, reason: `completed ${run.conclusion} push run on ${MASTER_BRANCH}`, run };
}

/**
 * The durable identity of one master incident: the immutable run id, the
 * attempt, and the tested commit.
 *
 * All three are needed. The run id alone would collapse a genuine re-run
 * (attempt 2 failing differently) into the first attempt's record; the
 * attempt alone is not unique across runs; and the SHA is what makes the
 * record answerable to "which code failed" after `master` has moved on.
 */
export function masterIncidentKey({ runId, runAttempt = 1, headSha } = {}) {
  if (!runId || !headSha) throw new Error("masterIncidentKey requires runId and headSha");
  return `master-ci:${runId}:${Number(runAttempt) || 1}:${headSha}`;
}

function failedJobs(run) {
  return (run.jobs || []).filter((job) => {
    const conclusion = lower(job.conclusion);
    return conclusion && !["success", "skipped", "neutral"].includes(conclusion);
  });
}

/**
 * Classify a master failure, reusing the shared CI classifier so a lane that
 * reads as `code-test` on a PR reads as `code-test` here too — including
 * `lane-ios`, which is exactly the parity the iOS fixture must prove.
 *
 * Two master-only overrides sit on top of it, both in the safe direction:
 * a production/migration/secret-shaped job is always `sensitive-permission`,
 * and a run that failed before any job reported (a `startup_failure`, or a
 * failure with no failed job at all) is `infrastructure-transient` rather
 * than `unknown`, because there is no repository evidence to repair from.
 *
 * @returns {{classification: string, reason: string, lanes: string[], events: object[]}}
 */
export function classifyMasterFailure(rawRun = {}) {
  const run = normalizeMasterRun(rawRun);
  const failures = failedJobs(run);
  const humanOnly = failures.filter((job) => HUMAN_ONLY_JOB_RE.test(text(job.name)));
  if (humanOnly.length) {
    return {
      classification: "sensitive-permission",
      reason: `${humanOnly.map((job) => text(job.name)).join(", ")} touches production, migration, or credential material — automation must never repair it`,
      lanes: humanOnly.map((job) => text(job.name)),
      events: [],
    };
  }
  if (!failures.length || run.conclusion === "startup_failure") {
    return {
      classification: "infrastructure-transient",
      reason: !failures.length
        ? `run concluded "${run.conclusion || "unknown"}" with no failed job reported — no repository evidence to repair from`
        : "run reported a startup failure, which is a runner/environment condition",
      lanes: failures.map((job) => text(job.name)),
      events: [],
    };
  }

  const events = failures.map((job) => ({
    name: text(job.name) || run.workflowName || "unknown-job",
    workflowName: run.workflowName,
    conclusion: lower(job.conclusion),
    sha: run.headSha,
    message: text(job.summary || job.message || ""),
  }));
  const classified = events.map((event) => ({ event, ...classifyFailure(event) }));
  // Rank so the least-automatable finding wins: one sensitive job in a run
  // makes the whole run sensitive, and one unknown makes it unknown. A run is
  // only `code-test` when every failed job is.
  const order = ["sensitive-permission", "unknown", "infrastructure-transient", "code-test", "non-actionable"];
  const worst = order.find((name) => classified.some((item) => item.classification === name)) || "unknown";
  const matching = classified.filter((item) => item.classification === worst);
  return {
    classification: worst === "non-actionable" ? "unknown" : worst,
    reason: matching.map((item) => `${item.check}: ${item.reason}`).join("; "),
    lanes: events.map((event) => event.name),
    events,
  };
}

/** Every distinct `MOV-NNN` in a block of text, upper-cased and de-duplicated. */
export function linearReferences(body) {
  const found = text(body).match(LINEAR_REFERENCE_RE) || [];
  return [...new Set(found.map((value) => value.toUpperCase()))];
}

/**
 * Attribute a failed master run to the pull request that produced it, and to
 * that PR's Linear issue.
 *
 * Two different kinds of "we do not know" are kept apart on purpose:
 *
 *   - **ambiguous** — GitHub cannot name exactly one source PR, or the one it
 *     names references more than one Linear issue. Nothing downstream can be
 *     trusted to pick the right one, so the incident stops for a human.
 *   - **absent** — the PR is unambiguous but carries no Linear reference at
 *     all. That is recorded as `sourceIssue: null` and is *not* an escalation:
 *     the evidence is complete, there is simply no upstream issue to link.
 *
 * @returns {{prNumber: number|null, prUrl: string|null, sourceIssue: string|null, ambiguous: boolean, reason: string}}
 */
export function attributeMasterRun({ pullRequests = [], prBody = null } = {}) {
  const candidates = (pullRequests || []).filter((pr) => Number(pr?.number) > 0);
  if (candidates.length === 0) {
    return {
      prNumber: null,
      prUrl: null,
      sourceIssue: null,
      ambiguous: true,
      reason: "GitHub attributes no pull request to the tested commit",
    };
  }
  if (candidates.length > 1) {
    return {
      prNumber: null,
      prUrl: null,
      sourceIssue: null,
      ambiguous: true,
      reason: `GitHub attributes ${candidates.length} pull requests (#${candidates.map((pr) => pr.number).join(", #")}) to the tested commit`,
    };
  }
  const [pr] = candidates;
  const references = linearReferences(prBody ?? pr.body ?? "");
  if (references.length > 1) {
    return {
      prNumber: Number(pr.number),
      prUrl: text(pr.url || pr.html_url) || null,
      sourceIssue: null,
      ambiguous: true,
      reason: `PR #${pr.number} references ${references.length} Linear issues (${references.join(", ")}) — no unambiguous source issue`,
    };
  }
  return {
    prNumber: Number(pr.number),
    prUrl: text(pr.url || pr.html_url) || null,
    sourceIssue: references[0] || null,
    ambiguous: false,
    reason: references.length
      ? `PR #${pr.number} references ${references[0]}`
      : `PR #${pr.number} carries no Linear reference — source issue recorded as absent`,
  };
}

/**
 * How the failed commit sits relative to `master` right now.
 *
 * `masterShas` is the recent first-parent commit list, newest first. A commit
 * that is no longer findable in it has been reverted, rewritten, or has
 * simply scrolled past the window — either way, a fix branched from current
 * `master` would be repairing code that is no longer there, which is exactly
 * the "stale lineage" case that must stop for a human.
 *
 * @returns {{current: boolean, distance: number|null, reason: string}}
 */
export function evaluateMasterLineage({ headSha, masterShas = [], maxDistance = 10 } = {}) {
  if (!headSha) return { current: false, distance: null, reason: "no tested commit SHA to locate" };
  if (!masterShas.length) return { current: false, distance: null, reason: `current ${MASTER_BRANCH} lineage could not be read` };
  const distance = masterShas.indexOf(headSha);
  if (distance === -1) {
    return {
      current: false,
      distance: null,
      reason: `tested commit ${headSha} is not in the last ${masterShas.length} commits of ${MASTER_BRANCH} — the lineage is stale or rewritten`,
    };
  }
  if (distance > maxDistance) {
    return {
      current: false,
      distance,
      reason: `tested commit ${headSha} is ${distance} commits behind ${MASTER_BRANCH} (limit ${maxDistance})`,
    };
  }
  return {
    current: true,
    distance,
    reason: distance === 0 ? `tested commit is the current ${MASTER_BRANCH} tip` : `tested commit is ${distance} commit(s) behind the ${MASTER_BRANCH} tip`,
  };
}

export const MASTER_INCIDENT_ACTIONS = Object.freeze(["route-fix-pr", "needs-human-decision"]);

/**
 * The whole decision, in one place.
 *
 * There are exactly two outcomes and the safe one is the default: anything
 * not provably a deterministic source-level failure on current, trusted,
 * unambiguously attributed `master` lineage — with budget left — is
 * `needs-human-decision`. Both outcomes still create or update the same
 * remediation record; the action decides where it is routed, never whether it
 * is recorded.
 *
 * @returns {{action: string, reason: string, humanDecision: string|null}}
 */
export function decideMasterIncident({
  classification,
  classificationReason = null,
  attribution = {},
  lineage = {},
  budget = {},
  incidentCreated = true,
} = {}) {
  const stop = (reason, humanDecision) => ({ action: "needs-human-decision", reason, humanDecision });

  if (!incidentCreated) {
    return stop(
      "the remediation record could not be created or updated",
      "create the remediation issue by hand from the evidence below, then decide whether the failure is repairable",
    );
  }
  if (classification === "sensitive-permission") {
    return stop(
      classificationReason || "failure involves credentials, permissions, production, or governance",
      "decide and apply the privileged fix yourself — automation has no authority here",
    );
  }
  if (classification === "infrastructure-transient") {
    return stop(
      classificationReason || "failure resembles a runner, network, or environment condition",
      `confirm the runner/environment is healthy and decide whether to re-run the workflow on the current ${MASTER_BRANCH} commit`,
    );
  }
  if (classification !== "code-test") {
    return stop(
      classificationReason || `failure classified as "${classification || "unknown"}"`,
      "identify the failure from the linked run before any fix is attempted",
    );
  }
  if (attribution.ambiguous) {
    return stop(
      attribution.reason || "the failed run cannot be attributed to one source pull request",
      "identify which change caused the failure and link it to this remediation item",
    );
  }
  if (!lineage.current) {
    return stop(
      lineage.reason || `the tested commit is not on current ${MASTER_BRANCH} lineage`,
      `confirm whether the failure still reproduces on current ${MASTER_BRANCH} before a fix branch is worth opening`,
    );
  }
  const used = Number(budget.used ?? 0);
  const limit = Number(budget.limit ?? 0);
  if (!(used < limit)) {
    return stop(
      `automatic remediation budget is exhausted (${used}/${limit} routed)`,
      `decide whether ${MASTER_BRANCH} needs a human-led fix before more automatic remediation is allowed`,
    );
  }
  return {
    action: "route-fix-pr",
    reason: `deterministic ${classification} failure on current ${MASTER_BRANCH} lineage, attributed to PR #${attribution.prNumber}`,
    humanDecision: null,
  };
}

/**
 * May this remediation item be completed?
 *
 * Both halves are required, and the second is the one that is easy to get
 * wrong: a green re-run of the *same* commit proves only that the run was
 * flaky, and a green run on an *older* commit proves nothing at all. The lane
 * must have passed on a commit that is strictly newer than the one that
 * failed, which is why lineage — not timestamps — is the arbiter.
 *
 * @returns {{complete: boolean, reason: string}}
 */
export function canCompleteMasterIncident({
  incidentSha,
  lane = null,
  mergedFixPr = null,
  successfulRun = null,
  masterShas = [],
} = {}) {
  if (!mergedFixPr) return { complete: false, reason: "no merged fix pull request is linked to this remediation item yet" };
  if (!successfulRun) return { complete: false, reason: `${lane || "the failing lane"} has not reported a success on a newer ${MASTER_BRANCH} commit` };
  const successSha = text(successfulRun.headSha);
  if (!successSha || successSha === incidentSha) {
    return { complete: false, reason: `the successful run re-ran the same commit ${incidentSha} — a green re-run on the original SHA does not close this` };
  }
  const successIndex = masterShas.indexOf(successSha);
  const incidentIndex = masterShas.indexOf(incidentSha);
  if (successIndex === -1 || incidentIndex === -1) {
    return { complete: false, reason: `could not place ${successSha} and ${incidentSha} on current ${MASTER_BRANCH} lineage` };
  }
  // Newest first: a strictly smaller index is a strictly newer commit.
  if (!(successIndex < incidentIndex)) {
    return { complete: false, reason: `${successSha} is not newer than the failing commit ${incidentSha} on ${MASTER_BRANCH}` };
  }
  return {
    complete: true,
    reason: `PR #${mergedFixPr.number} merged and ${lane || "the failing lane"} succeeded on ${successSha}, ${incidentIndex - successIndex} commit(s) newer than ${incidentSha}`,
  };
}
