// The issue completeness contract (MOV-303).
//
// Outside `Triage`, an issue must be filed fully specced: all applicable
// labels, a project, and a milestone unless one genuinely does not apply. The
// contract itself is documented in
// docs/governance/linear-information-architecture.md §Issue completeness
// contract; this module is its only machine-checkable expression.
//
// Pure decision logic with no Linear I/O, so every rule below is unit-testable
// against a plain object. Two callers consume it: the promoter's gate
// (`promoter.mjs`, which refuses to promote an incomplete issue in `enforce`
// mode) and the audit pass (`issue-spec-audit.mjs`, which comments on
// non-compliant open issues in any state). Neither ever fills a missing field
// in: choosing a label, project, or milestone is a human or authoring-agent
// decision, and a guess written by the dispatcher would be indistinguishable
// from a real one afterwards.
//
// Deliberately NOT checked here: relation completeness. The contract requires
// genuine `blocks` / `blocked by` / parent relations, but whether an issue's
// relations are *complete* is not mechanically decidable — there is no signal
// that distinguishes "has no prerequisites" from "its prerequisites were never
// recorded". That half of the contract is carried by documentation only, and
// this validator must never claim to have checked it.

import { isCoordinationIssue } from "./execution-routing.mjs";
import { resolveRouting } from "./worker-routing.mjs";

export const ISSUE_SPEC_MODES = ["off", "report", "enforce"];
export const DEFAULT_ISSUE_SPEC_MODE = "report";

export const TRIAGE_STATE_NAME = "Triage";
export const TERMINAL_SPEC_STATE_NAMES = ["Done", "Released", "Canceled", "Duplicate"];
/** States the contract does not apply to at all: intake, and everything finished. */
export const EXEMPT_SPEC_STATE_NAMES = [TRIAGE_STATE_NAME, ...TERMINAL_SPEC_STATE_NAMES];

/**
 * The Linear workflow-state *types* the audit pass scans. Selecting by type
 * rather than by name is what makes "every open non-Triage issue" true for
 * states this code has never heard of: a state added to the workspace later is
 * audited automatically, while `triage`, `completed`, and `canceled` stay out
 * by construction rather than by keeping a name list in step with the
 * workspace. `EXEMPT_SPEC_STATE_NAMES` above remains the belt-and-braces check
 * inside the validator itself, for callers that pass an issue in by hand.
 */
export const AUDITED_SPEC_STATE_TYPES = new Set(["backlog", "unstarted", "started"]);

/**
 * Project statuses that make a project an invalid home for open work. Anything
 * else — including an unknown or absent status, which is what a Linear
 * credential without project visibility returns — counts as open: this check
 * exists to catch a finished project being reused as a maintenance bucket, and
 * flagging every issue on a project whose status could not be read would be a
 * false positive on every issue at once.
 */
const TERMINAL_PROJECT_STATUSES = new Set(["completed", "canceled", "cancelled"]);

/**
 * The explicit milestone opt-out: `Milestone: N/A — <reason>` on its own line.
 * The reason is mandatory and must be non-empty — an unexplained opt-out is
 * indistinguishable from forgetting the field, which is the thing this exists
 * to catch. An em dash, en dash, or plain hyphen all separate it, and the line
 * may be bulleted and/or bold so it reads naturally inside a description.
 */
const MILESTONE_OPT_OUT_RE =
  /^[ \t>]*(?:[-*+][ \t]+)?\*{0,2}Milestone:?\*{0,2}[ \t]*N\/A[ \t]*[—–-][ \t]*(\S[^\n]*)$/im;

/** True when `description` carries a valid, reasoned milestone opt-out line. */
export function milestoneOptOutReason(description) {
  const match = MILESTONE_OPT_OUT_RE.exec(String(description || ""));
  if (!match) return null;
  const reason = match[1].trim();
  return reason.length > 0 ? reason : null;
}

/**
 * Which set of rules applies to this issue.
 *
 * `human-only` is checked before coordination: it is the stricter of the two
 * (it additionally requires `type:*`), and an issue carrying both labels is
 * still work a human does by hand. Coordination detection reuses
 * `isCoordinationIssue()` rather than testing `type:coordination` directly, so
 * this and the promoter's existing coordination gate can never disagree about
 * what a coordination issue is.
 */
export function issueSpecKind(issue = {}) {
  const labels = issue.labels || [];
  if (labels.includes("human-only")) return "human-only";
  if (isCoordinationIssue(issue)) return "coordination";
  return "dispatchable";
}

export const ISSUE_SPEC_KIND_DESCRIPTIONS = {
  dispatchable: "dispatchable (not `human-only`, not `type:coordination`)",
  "human-only": "`human-only` (a human does this by hand; no worker/model routing applies)",
  coordination: "coordination (`type:coordination`; produces no implementation PR)",
};

function labelsInGroup(labels, group) {
  const prefix = `${group}:`;
  return labels.filter((label) => label.startsWith(prefix));
}

function requireExactlyOne(missing, labels, group) {
  const found = labelsInGroup(labels, group);
  if (found.length === 0) {
    missing.push({ code: `${group}-missing`, message: `no \`${group}:*\` label` });
  } else if (found.length > 1) {
    missing.push({
      code: `${group}-multiple`,
      message: `multiple \`${group}:*\` labels (${found.join(", ")}) — exactly one is allowed`,
    });
  }
}

function requireAtLeastOne(missing, labels, group) {
  if (labelsInGroup(labels, group).length === 0) {
    missing.push({ code: `${group}-missing`, message: `no \`${group}:*\` label` });
  }
}

function requireExecutionNone(missing, labels, kind) {
  const found = labelsInGroup(labels, "execution");
  const why = kind === "human-only" ? "`human-only`" : "coordination";
  if (found.length === 0) {
    missing.push({ code: "execution-missing", message: `no \`execution:none\` label (required on ${why} issues)` });
  } else if (found.length > 1 || found[0] !== "execution:none") {
    missing.push({
      code: "execution-wrong",
      message: `\`execution:none\` is required on ${why} issues (found ${found.join(", ")})`,
    });
  }
}

/**
 * Evaluate one issue against the completeness contract.
 *
 * @param {object} issue
 * @param {string} [issue.stateName] - workflow state name; `Triage` and every
 *   terminal state are exempt. An issue with no state name is evaluated (the
 *   promoter only ever passes issues it already knows are in Backlog/Blocked).
 * @param {string[]} [issue.labels]
 * @param {string|null} [issue.project] - project name, or null when unassigned
 * @param {string|null} [issue.projectStatus] - the project's own status
 *   ("planned", "started", "completed", "canceled", …); unknown counts as open
 * @param {number} [issue.projectMilestoneCount] - how many milestones the
 *   issue's project defines; a project with none cannot require one
 * @param {string|null} [issue.milestone] - project-milestone name, or null
 * @param {string} [issue.description]
 * @returns {{exempt: boolean, kind: string|null, missing: Array<{code: string, message: string}>, ok: boolean, reason: string|null}}
 */
export function evaluateIssueSpec(issue = {}) {
  const stateName = issue.stateName ?? null;
  if (stateName && EXEMPT_SPEC_STATE_NAMES.includes(stateName)) {
    return {
      exempt: true,
      kind: null,
      missing: [],
      ok: true,
      reason: `state "${stateName}" is exempt from the issue completeness contract`,
    };
  }

  const labels = issue.labels || [];
  const kind = issueSpecKind(issue);
  const missing = [];

  if (kind === "dispatchable") {
    requireExactlyOne(missing, labels, "execution");
  } else {
    requireExecutionNone(missing, labels, kind);
  }

  // A coordination issue is identified *by* its type label, so re-requiring
  // `type:*` on it would be vacuous. Every other kind must state its type.
  if (kind !== "coordination") requireExactlyOne(missing, labels, "type");

  requireExactlyOne(missing, labels, "risk");

  if (kind === "dispatchable") {
    requireExactlyOne(missing, labels, "worker");
    requireExactlyOne(missing, labels, "model");
    // Reuse the routing rubric's own upgrade rule rather than restating it:
    // `model:strong` without an `upgrade:*` label is rejected at dispatch by
    // resolveRouting(), and catching it here means it is caught at intake
    // instead of after the issue has already been promoted. Calling the real
    // function (not a copy of its regex) is what keeps the two in step.
    const routing = resolveRouting(issue);
    if (!routing.ok) missing.push({ code: "upgrade-missing", message: routing.reason });
  }

  requireAtLeastOne(missing, labels, "area");

  if (!issue.project) {
    missing.push({
      code: "project-missing",
      message: "no project — every non-`Triage` issue must belong to a project",
    });
  } else {
    const status = String(issue.projectStatus || "").toLowerCase();
    if (TERMINAL_PROJECT_STATUSES.has(status)) {
      missing.push({
        code: "project-terminal",
        message: `project "${issue.project}" is ${status} — assign a project that is still open`,
      });
    }
  }

  const milestoneCount = Number.isInteger(issue.projectMilestoneCount) ? issue.projectMilestoneCount : 0;
  if (!issue.milestone && milestoneCount > 0 && !milestoneOptOutReason(issue.description)) {
    missing.push({
      code: "milestone-missing",
      message:
        `no milestone — project "${issue.project}" defines ${milestoneCount} milestone(s); ` +
        'set one, or add an explicit `Milestone: N/A — <reason>` line to the description',
    });
  }

  return {
    exempt: false,
    kind,
    missing,
    ok: missing.length === 0,
    reason: missing.length === 0 ? null : formatIssueSpecMissing(missing),
  };
}

/** One human-readable line naming every missing item, in evaluation order. */
export function formatIssueSpecMissing(missing = []) {
  return missing.map((item) => item.message).join("; ");
}

/**
 * A stable identity for a *set* of missing items, independent of the wording
 * of their messages. The audit pass compares this across cycles so it can
 * re-comment when what's missing changes and stay silent when it hasn't.
 */
export function issueSpecFingerprint(missing = []) {
  return missing
    .map((item) => item.code)
    .sort()
    .join(",");
}
