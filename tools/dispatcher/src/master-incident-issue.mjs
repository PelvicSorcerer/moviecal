// The Linear remediation item a post-merge `master` failure produces (MOV-305).
//
// A master incident is worth nothing as a log line. It has to become an
// ordinary, fully specced Linear issue that the existing promoter can route
// without anybody hand-writing an intake pass — which means it must satisfy
// two separate contracts this repository already enforces:
//
//   - **the readiness contract** (promoter.mjs): a non-empty
//     acceptance-criteria section and a non-empty Testing Expectations
//     section, matched by heading;
//   - **the issue completeness contract** (issue-spec.mjs): exactly one each
//     of `execution:*`, `type:*`, `risk:*`, `worker:*`, `model:*`, at least
//     one `area:*`, a project, and a milestone unless a reasoned opt-out line
//     is present.
//
// Both are asserted in this module's own tests against the real validators,
// not against a copy of their rules — a remediation issue that cannot be
// promoted is the same as no remediation issue at all.
//
// `risk:high` is not a hedge. It is the label that keeps MOV-162's risk-scoped
// PR autonomy (which requires `risk:low`) from ever making a master-remediation
// PR ready or merging it unattended.

const MASTER_REMEDIATION_LABELS = Object.freeze([
  "execution:mac",
  "type:fix",
  "risk:high",
  "worker:any",
  "model:default",
  "area:process",
  "area:tests",
]);

/** Marker that identifies a dispatcher-written master-incident comment. */
export const MASTER_INCIDENT_COMMENT_MARKER = "moviecal-master-incident";

export function masterIncidentLabels() {
  return [...MASTER_REMEDIATION_LABELS];
}

function text(value) {
  return String(value ?? "").trim();
}

function shortSha(sha) {
  return text(sha).slice(0, 12) || "unknown";
}

function laneList(evidence) {
  const lanes = (evidence.lanes || []).map(text).filter(Boolean);
  return lanes.length ? lanes.join(", ") : evidence.workflowName || "unknown lane";
}

/** The one-line title, stable enough to recognize and specific enough to search. */
export function masterIncidentTitle(evidence = {}) {
  return `Fix failed ${laneList(evidence)} on master (run ${evidence.runId ?? "unknown"}, ${shortSha(evidence.headSha)})`;
}

/**
 * The evidence block every surface shares — the issue body, the escalation
 * comment, and the reconciliation comment all render the same facts from the
 * same function, so an operator never has to reconcile two spellings of one
 * incident.
 */
export function masterIncidentEvidenceBlock(evidence = {}) {
  const rows = [
    ["Failed run", evidence.runUrl ? `[${evidence.runId}](${evidence.runUrl})` : `run ${evidence.runId ?? "unknown"}`],
    ["Workflow", `\`${text(evidence.workflowName) || "unknown"}\``],
    ["Lane / job", `\`${laneList(evidence)}\``],
    ["Conclusion", `\`${text(evidence.conclusion) || "unknown"}\``],
    ["Attempt", String(evidence.runAttempt ?? 1)],
    ["Tested commit", `\`${text(evidence.headSha) || "unknown"}\``],
    ["Observed at", text(evidence.observedAt) || "unknown"],
    ["Run started", text(evidence.runCreatedAt) || "unknown"],
    [
      "Source PR",
      evidence.prNumber
        ? evidence.prUrl
          ? `[#${evidence.prNumber}](${evidence.prUrl})`
          : `#${evidence.prNumber}`
        : "_not attributable_",
    ],
    ["Source issue", evidence.sourceIssue ? text(evidence.sourceIssue) : "_none referenced_"],
    ["Classification", `\`${text(evidence.classification) || "unknown"}\``],
    ["Incident key", `\`${text(evidence.key)}\``],
  ];
  return ["| Field | Value |", "|---|---|", ...rows.map(([name, value]) => `| ${name} | ${value} |`)].join("\n");
}

/**
 * The full remediation issue body.
 *
 * `milestoneAssigned: false` adds the explicit, reasoned milestone opt-out
 * line the completeness contract requires, rather than leaving the issue
 * silently incomplete when the configured project's milestone could not be
 * resolved.
 */
export function masterIncidentIssueBody({ evidence = {}, decision = {}, milestoneAssigned = true, repo = null } = {}) {
  const lane = laneList(evidence);
  const sections = [
    "## Goal",
    "",
    `Restore a green \`${lane}\` on \`master\` by fixing the defect the failed run below exposed, through one ordinary fix branch and pull request based on current \`master\`.`,
    "",
    "This issue was created automatically by the dispatcher's post-merge master-failure observer (MOV-305). It is defence in depth *after* the required pre-merge PR checks (MOV-301/MOV-302), never a substitute for them.",
    "",
    "## Evidence",
    "",
    masterIncidentEvidenceBlock(evidence),
    "",
    evidence.classificationReason ? `Classifier detail: ${evidence.classificationReason}` : "",
    "",
    "## Acceptance Criteria",
    "",
    `* The defect that failed \`${lane}\` on \`${shortSha(evidence.headSha)}\` is fixed in the repository, or this issue records why the failure was not a repository defect.`,
    "* The fix is delivered as one ordinary pull request from a fresh branch based on current `master`.",
    `* \`${lane}\` passes on a \`master\` commit newer than \`${shortSha(evidence.headSha)}\` after that pull request merges.`,
    "* No commit, merge, revert, force-push, or blind re-run is performed against `master` directly.",
    "* The original failed-run evidence above is preserved in this issue.",
    "",
    "## Testing Expectations",
    "",
    "* **Unit:** cover the specific defect the failed lane exposed, where it is unit-coverable.",
    "* **Integration:** extend the deterministic integration lane when the failure only reproduces across module boundaries.",
    "* **Browser E2E:** only if the failing lane was `lane-browser`.",
    `* **iOS:** only if the failing lane was \`lane-ios\`; in that case run the iOS lane locally before handoff.`,
    "* **Regression:** `npm run verify` must pass locally before publication.",
    "",
    "## Manual Verification",
    "",
    "Human testing: required",
    "",
    `* **Setup:** read the failed run linked above and reproduce the failing \`${lane}\` locally on current \`master\`.`,
    "* **Happy path:** apply the fix on a branch from current `master` and confirm the previously failing lane passes locally.",
    "* **Edge cases:** confirm the failure was deterministic rather than a runner/environment condition; if it was environmental, say so here and stop.",
    "* **Regression:** confirm no other verification lane regressed.",
    `* **Expected result:** \`${lane}\` is green on a \`master\` commit newer than \`${shortSha(evidence.headSha)}\`.`,
    "",
    "## Out of Scope",
    "",
    "* Any direct write, revert, rollback, or blind re-run against `master`.",
    "* Changing the `master-protection` ruleset or the pre-merge lane gating.",
    "",
  ];
  if (!milestoneAssigned) {
    sections.push(
      "Milestone: N/A — automatically filed master-failure remediation; it belongs to no planned project phase and is scheduled by the failure, not by a milestone.",
      "",
    );
  }
  if (evidence.sourceIssue) {
    sections.push(`Source issue: ${evidence.sourceIssue}`, "");
  }
  if (decision.action) {
    sections.push(`Routing decision: \`${decision.action}\` — ${decision.reason}`, "");
  }
  if (repo) sections.push(`Repository: \`${repo}\``, "");
  sections.push(`<!-- ${MASTER_INCIDENT_COMMENT_MARKER}:${text(evidence.key)} -->`);
  return sections.filter((line) => line !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The comment written when an incident stops for a human. Acceptance
 * criterion 5 names its four required parts explicitly: the failed-run URL,
 * the SHA, the failure classification, and the next required human decision.
 */
export function masterIncidentHumanDecisionComment({ evidence = {}, decision = {} } = {}) {
  return [
    `**Master CI failure needs a human decision (MOV-305).**`,
    "",
    `Failed run: ${evidence.runUrl || `run ${evidence.runId ?? "unknown"}`}`,
    `Tested commit: \`${text(evidence.headSha) || "unknown"}\``,
    `Failure classification: \`${text(evidence.classification) || "unknown"}\``,
    `Why automation stopped: ${decision.reason || "unspecified"}`,
    `Next required human decision: ${decision.humanDecision || "decide how this failure should be remediated"}`,
    "",
    masterIncidentEvidenceBlock(evidence),
    "",
    "The dispatcher has taken no action against `master` and will take none: it cannot commit to, merge into, re-run blindly against, revert, or rewrite `master`.",
    "",
    `<!-- ${MASTER_INCIDENT_COMMENT_MARKER}:${text(evidence.key)}:needs-human-decision -->`,
  ].join("\n");
}

/** The comment written when an incident is routed for an ordinary fix PR. */
export function masterIncidentRoutedComment({ evidence = {}, decision = {} } = {}) {
  return [
    `**Master CI failure routed for an ordinary fix PR (MOV-305).**`,
    "",
    `Failed run: ${evidence.runUrl || `run ${evidence.runId ?? "unknown"}`}`,
    `Tested commit: \`${text(evidence.headSha) || "unknown"}\``,
    `Failure classification: \`${text(evidence.classification) || "unknown"}\``,
    `Why it is safe to route: ${decision.reason || "unspecified"}`,
    "",
    "This item is filed fully specced in `Backlog`. It reaches a worker only through the ordinary promote → delegate → dispatch path, which branches from current `master` and opens a draft PR. Nothing here writes to `master`.",
    "",
    `<!-- ${MASTER_INCIDENT_COMMENT_MARKER}:${text(evidence.key)}:routed -->`,
  ].join("\n");
}

/** The comment written when an incident is finally reconciled. */
export function masterIncidentReconciledComment({ evidence = {}, reconciliation = {} } = {}) {
  return [
    `**Master CI failure remediated (MOV-305).**`,
    "",
    `Original failed run: ${evidence.runUrl || `run ${evidence.runId ?? "unknown"}`} on \`${text(evidence.headSha)}\``,
    `Merged fix PR: #${reconciliation.prNumber ?? "unknown"}`,
    `Verified green: \`${laneList(evidence)}\` succeeded on \`${text(reconciliation.verifiedSha) || "unknown"}\``,
    `Reason: ${reconciliation.reason || "unspecified"}`,
    "",
    "The original failure evidence and ledger entry are retained.",
    "",
    `<!-- ${MASTER_INCIDENT_COMMENT_MARKER}:${text(evidence.key)}:reconciled -->`,
  ].join("\n");
}

/**
 * The comment left on the *source* Linear issue when a master failure is
 * attributed to it. One comment, informational only: the source issue is
 * already `Done`, and reopening somebody's completed work from a post-merge
 * observation is a decision, not a bookkeeping step.
 */
export function masterIncidentSourceComment({ evidence = {}, remediation = {} } = {}) {
  return [
    `**A post-merge \`master\` verification run attributed to this issue failed (MOV-305).**`,
    "",
    `Failed run: ${evidence.runUrl || `run ${evidence.runId ?? "unknown"}`}`,
    `Remediation item: ${remediation.identifier ? `${remediation.identifier}${remediation.url ? ` (${remediation.url})` : ""}` : "_not yet created_"}`,
    "",
    "This is a notice, not a state change: the remediation item above owns the follow-up.",
    "",
    `<!-- ${MASTER_INCIDENT_COMMENT_MARKER}:${text(evidence.key)}:source-notice -->`,
  ].join("\n");
}
