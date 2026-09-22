// The issue-completeness audit pass (MOV-303).
//
// Every dispatcher cycle (and on demand via `dispatcher audit-issues
// [--dry-run]`) this scans every open non-`Triage` issue — including
// `human-only`, coordination, `Spec Ready`, `Icebox`, and started states,
// none of which the promoter ever looks at — and posts **one** dispatcher
// comment per non-compliant issue listing exactly what is missing.
//
// Two properties matter more than anything else here:
//
//   1. **It never mutates the issue.** No label, project, milestone, or state
//      is written. Filling those in is a human or authoring-agent decision;
//      a dispatcher-guessed label would be indistinguishable from a real one
//      the moment it landed.
//   2. **It does not nag.** A comment is posted the first time a missing set
//      is observed and then only again if that set *changes*. Once the issue
//      complies, nothing further is posted — including no "resolved" comment,
//      which would be a second kind of noise on an issue that is now fine.
//
// Property 2 is implemented with a fingerprint embedded in an HTML comment on
// the audit comment itself, so the state lives on the issue rather than in a
// local file: a dispatcher restart, a new Mac, or a wiped config directory
// cannot make it repeat itself.

import { evaluateIssueSpec, issueSpecFingerprint, ISSUE_SPEC_KIND_DESCRIPTIONS, DEFAULT_ISSUE_SPEC_MODE } from "./issue-spec.mjs";

export const AUDIT_COMMENT_HEADLINE =
  "**Issue completeness contract — this issue is missing required fields (MOV-303).**";

const MARKER_PREFIX = "dispatcher:issue-spec-audit v1 missing=";
const MARKER_RE = /<!--\s*dispatcher:issue-spec-audit v1 missing=([^\s]*)\s*-->/g;

/** The hidden marker that records which missing set a comment was written for. */
export function auditCommentMarker(missing) {
  return `<!-- ${MARKER_PREFIX}${issueSpecFingerprint(missing)} -->`;
}

/**
 * The fingerprint on the most recent audit comment in `recentComments`
 * (oldest-to-newest), or null when this issue has never been audited. A
 * comment that carries no marker is somebody else's and is ignored.
 */
export function lastAuditFingerprint(recentComments = []) {
  for (let i = recentComments.length - 1; i >= 0; i--) {
    const matches = [...String(recentComments[i] || "").matchAll(MARKER_RE)];
    if (matches.length > 0) return matches[matches.length - 1][1];
  }
  return null;
}

/** The comment body for one non-compliant issue. */
export function auditCommentBody(evaluation) {
  return [
    AUDIT_COMMENT_HEADLINE,
    "",
    `Kind: ${ISSUE_SPEC_KIND_DESCRIPTIONS[evaluation.kind] || evaluation.kind}`,
    "",
    "Missing or invalid:",
    ...evaluation.missing.map((item) => `- ${item.message}`),
    "",
    "The dispatcher does **not** set these for you — choosing a label, project, or milestone is a human (or authoring-agent) decision, and this pass never changes an issue's fields or state.",
    "",
    "Relations (`blocks` / `blocked by` / parent) are also required by the contract but are deliberately **not** checked here: their completeness is not mechanically decidable. See `docs/governance/linear-information-architecture.md` §Issue completeness contract.",
    "",
    "_Posted once per distinct set of missing items: it is not repeated while that set is unchanged, and nothing further is posted once the issue complies._",
    "",
    auditCommentMarker(evaluation.missing),
  ].join("\n");
}

/**
 * Audit every issue and comment on the non-compliant ones.
 *
 * @param {object[]} issues - normalized issues carrying the spec fields
 *   (`labels`, `project`, `projectStatus`, `projectMilestoneCount`,
 *   `milestone`, `description`, `stateName`) plus `recentComments`
 * @param {object} ctx
 * @param {object} ctx.linearClient - only `addComment` is ever called
 * @param {boolean} [ctx.dryRun] - evaluate and report, write nothing
 * @param {"off"|"report"|"enforce"} [ctx.mode] - `off` reports without writing,
 *   exactly like a dry run; `report` and `enforce` both comment. The mode's
 *   other half (whether an incomplete issue is still promoted) belongs to the
 *   promoter, not here: an issue nobody is told about cannot be fixed, so the
 *   audit behaves identically in `report` and `enforce`.
 * @returns {Promise<Array<{issue: string, action: string, missing: string[], fingerprint: string|null}>>}
 */
export async function auditIssueSpecs(issues, ctx) {
  const { linearClient, dryRun = false, mode = DEFAULT_ISSUE_SPEC_MODE } = ctx;
  const readOnly = dryRun || mode === "off";
  const results = [];

  for (const issue of issues) {
    const evaluation = evaluateIssueSpec(issue);
    const base = { issue: issue.identifier, missing: evaluation.missing.map((item) => item.message) };

    if (evaluation.exempt) {
      results.push({ ...base, action: "exempt", fingerprint: null });
      continue;
    }
    if (evaluation.ok) {
      // Compliant: post nothing at all, including no retraction of an earlier
      // comment. The earlier comment stays as the record of what was fixed.
      results.push({ ...base, action: "compliant", fingerprint: null });
      continue;
    }

    const fingerprint = issueSpecFingerprint(evaluation.missing);
    const previous = lastAuditFingerprint(issue.recentComments);
    if (previous === fingerprint) {
      results.push({ ...base, action: "unchanged", fingerprint });
      continue;
    }

    if (readOnly) {
      results.push({ ...base, action: "would-comment", fingerprint });
      continue;
    }

    await linearClient.addComment(issue.id, auditCommentBody(evaluation));
    results.push({ ...base, action: previous === null ? "commented" : "updated", fingerprint });
  }

  return results;
}
