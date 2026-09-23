// The issue-completeness audit pass (MOV-308).
//
// The promoter's gate (`promoter.mjs`, MOV-307) is the contract's first
// consumer, but it only ever looks at `Backlog` and `Blocked`. Everything else
// that is open — `human-only`, coordination, `Spec Ready`, `Icebox`, and every
// started state — is never evaluated by it at all, which is most of the
// workspace. This pass covers that gap: it reads every open non-`Triage` issue
// and leaves exactly one comment on each non-compliant one.
//
// **Commenting is the only thing it does.** It never moves an issue, never
// changes a priority, and never writes a label, project, or milestone —
// `addComment` is its sole mutation, asserted structurally in
// `dispatcher-wiring.test.mjs` as well as behaviourally here. That is
// deliberate and matches the contract's own "nothing is ever auto-filled"
// rule: choosing a label, project, or milestone is a human or authoring-agent
// decision, and a dispatcher-written guess would be indistinguishable from a
// real one the moment it landed. Nor does the audit ever *block* anything —
// enforcement lives in the promoter, which is the pass that can actually
// withhold dispatch.
//
// **Don't repeat yourself.** This runs every poll cycle, so a naive
// implementation would bury an issue under an identical comment every 30
// seconds. Each comment carries a hidden fingerprint marker naming the *set*
// of missing items (by code, not by message wording). On a later pass:
//
//   - the same missing set  -> nothing is written at all;
//   - a changed missing set -> exactly one new comment;
//   - a now-compliant issue -> nothing, not even a "resolved" note. A silent
//     issue is the normal state of a healthy workspace, and a resolution
//     comment on every fix would be pure noise.
//
// Pure decision logic lives in `issue-spec.mjs`; this module is the I/O half,
// with its Linear client injected so every rule above is testable against a
// fake. See docs/operators/local-execution.md §Issue completeness and
// docs/governance/linear-information-architecture.md §Issue completeness
// contract.

import { evaluateIssueSpec, issueSpecFingerprint, ISSUE_SPEC_KIND_DESCRIPTIONS } from "./issue-spec.mjs";
import { JsonStateStore } from "./state-store.mjs";

/**
 * The first line of every audit comment. Named and exported so the tests, the
 * docs, and anyone grepping Linear for the pass's output all agree on one
 * exact string.
 */
export const AUDIT_COMMENT_HEADLINE =
  "**Issue completeness contract — this issue is missing required fields (MOV-303).**";

const MARKER_PREFIX = "moviecal-issue-spec-audit:";
const MARKER_RE = new RegExp(`<!--\\s*${MARKER_PREFIX}([^\\s>]*)\\s*-->`, "g");

/**
 * The marker's payload for a given fingerprint.
 *
 * An HTML comment cannot contain `--`, and `>` would end it early, so the
 * fingerprint is normalized into a token before it is embedded. Both the write
 * side (`auditCommentMarker`) and the compare side (`auditFingerprintToken`
 * against a parsed marker) go through this same function, so the round-trip
 * stays exact even though the transform itself is lossy — the human-readable
 * list of what is missing lives in the comment body, not in the marker.
 */
export function auditFingerprintToken(fingerprint) {
  return String(fingerprint ?? "")
    .replace(/[^A-Za-z0-9,._-]/g, "")
    .replace(/-{2,}/g, "-");
}

/** The hidden marker line appended to every audit comment. */
export function auditCommentMarker(fingerprint) {
  return `<!-- ${MARKER_PREFIX}${auditFingerprintToken(fingerprint)} -->`;
}

/**
 * The fingerprint token carried by `body`, or null when it is not an audit
 * comment. A body carrying more than one marker (an edit that concatenated two
 * of them, say) reads as its last, which is the one that describes the comment
 * as it now stands.
 */
export function parseAuditCommentMarker(body) {
  const matches = String(body ?? "").matchAll(MARKER_RE);
  let last = null;
  for (const match of matches) last = match[1];
  return last;
}

/**
 * The fingerprint token from the most recent audit comment in `comments`
 * (oldest-to-newest, exactly as `issuesForSpecAudit` returns them), or null if
 * the pass has never commented on this issue.
 *
 * Reading the *last* one matters: the promoter writes its own comments to the
 * same issues, and a fix-then-regress sequence leaves several audit comments
 * behind. Only the newest describes what the issue is missing now.
 */
export function lastAuditFingerprint(comments = []) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const token = parseAuditCommentMarker(comments[i]);
    if (token !== null) return token;
  }
  return null;
}

/**
 * The full comment body for one non-compliant issue: the headline, which set
 * of rules was applied, every missing item, where the contract is written
 * down, and the hidden marker.
 *
 * @param {{kind: string|null, missing: Array<{code: string, message: string}>}} evaluation
 *   the result of `evaluateIssueSpec()` for a non-compliant issue
 */
export function auditCommentBody(evaluation) {
  const missing = evaluation.missing || [];
  const kindLine = ISSUE_SPEC_KIND_DESCRIPTIONS[evaluation.kind]
    ? `Evaluated as **${evaluation.kind}** — ${ISSUE_SPEC_KIND_DESCRIPTIONS[evaluation.kind]}.`
    : null;
  return [
    AUDIT_COMMENT_HEADLINE,
    "",
    ...(kindLine ? [kindLine, ""] : []),
    ...missing.map((item) => `- ${item.message}`),
    "",
    "The contract is `docs/governance/linear-information-architecture.md` §Issue completeness contract. " +
      "Nothing here is auto-filled — choosing a label, project, or milestone is a human decision — and this " +
      "comment changes no state: it is a report, not a block.",
    "",
    auditCommentMarker(issueSpecFingerprint(missing)),
  ].join("\n");
}

/**
 * Audit every issue in `issues` and comment on the non-compliant ones.
 *
 * The caller resolves which issues to pass in — `bin/dispatcher.mjs` selects
 * them by workflow-state *type* (`AUDITED_SPEC_STATE_TYPES`) rather than by a
 * hardcoded name list, so a state added to the workspace later is audited
 * automatically. This function audits exactly what it is handed, and applies
 * `evaluateIssueSpec()`'s own exemptions as a second, independent check.
 *
 * @param {object[]} issues - normalized issues carrying the issue-spec fields
 *   and `recentComments` (oldest-to-newest), i.e. `issuesForSpecAudit()` output
 * @param {object} ctx
 * @param {{addComment: (issueId: string, body: string) => Promise<any>}} ctx.linearClient
 * @param {boolean} [ctx.dryRun] - evaluate and report, write nothing
 * @returns {Promise<Array<{issue: string, action: "exempt"|"compliant"|"unchanged"|"commented"|"updated", missing: string[], fingerprint: string|null, reason: string|null}>>}
 *   one result per issue, in input order
 */
export async function auditIssueSpecs(issues = [], ctx = {}) {
  const { linearClient, dryRun = false } = ctx;
  const results = [];

  for (const issue of issues) {
    const evaluation = evaluateIssueSpec(issue);
    const base = { issue: issue.identifier, missing: [], fingerprint: null, reason: null };

    if (evaluation.exempt) {
      results.push({ ...base, action: "exempt", reason: evaluation.reason });
      continue;
    }
    if (evaluation.ok) {
      // Deliberately silent: no comment, and no "resolved" comment either.
      results.push({ ...base, action: "compliant" });
      continue;
    }

    const fingerprint = auditFingerprintToken(issueSpecFingerprint(evaluation.missing));
    const previous = lastAuditFingerprint(issue.recentComments);
    const missing = evaluation.missing.map((item) => item.message);

    if (previous === fingerprint) {
      results.push({ ...base, action: "unchanged", missing, fingerprint, reason: evaluation.reason });
      continue;
    }

    if (!dryRun) await linearClient.addComment(issue.id, auditCommentBody(evaluation));
    results.push({
      ...base,
      action: previous === null ? "commented" : "updated",
      missing,
      fingerprint,
      reason: evaluation.reason,
    });
  }

  return results;
}

/**
 * Persisted `{ lastRunAt: <epoch ms> }` for the audit's cadence, at
 * `config.mjs`'s `issueSpecAuditStatePath()`. Reuses `JsonStateStore`'s
 * fsync+rename+backup durability (state-store.mjs) rather than a bespoke
 * write, and only for the automatic in-loop scheduling decision -- the
 * standalone `dispatcher audit-issues` command never reads or writes it, so
 * a manual run is never gated by the interval.
 */
export class IssueSpecAuditScheduleStore extends JsonStateStore {
  get label() {
    return "issue-spec audit schedule";
  }

  /**
   * A missing file reads as "never run" (empty object -> `lastRunAt`
   * undefined). A corrupt file with no valid backup would otherwise make
   * `JsonStateStore.load()` throw; treated here as "never run" too, rather
   * than propagating, so a damaged schedule file causes one audit to run
   * instead of silently skipping every cycle forever.
   */
  loadOrReset() {
    try {
      return this.load();
    } catch {
      return {};
    }
  }
}

/**
 * Pure scheduling decision: is the automatic audit due? `lastRunAt` is
 * whatever `IssueSpecAuditScheduleStore#loadOrReset().lastRunAt` returned --
 * `undefined`/`null`/anything non-numeric all count as "never run" and are
 * due immediately.
 */
export function isAuditDue(lastRunAt, nowMs, intervalMs) {
  return typeof lastRunAt !== "number" || !Number.isFinite(lastRunAt) || nowMs - lastRunAt >= intervalMs;
}
