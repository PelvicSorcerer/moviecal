// Automated backlog promoter (MOV-129).
//
// Moves issues that meet a machine-checkable "definition of ready" from
// `Backlog` / `Blocked` into `Ready for Agent`, so the dispatch queue fills
// itself and no issue is ever hand-promoted. `blocks` relations plus the
// dispatcher's preflight do all sequencing; this module never reasons about
// order, only about readiness. `Spec Ready` is a manual hold the promoter
// never touches.
//
// Pure decision logic (`evaluatePromotion`) is separated from I/O
// (`promoteEligible`) so the contract is fully unit-testable with fakes.
// See docs/operators/local-execution.md §Automated promotion and MOV-129.

import { isCoordinationIssue } from "./execution-routing.mjs";

const ACCEPTANCE_HEADING_RE = /^#{1,6}[ \t]*acceptance criteria\b/im;
const TESTING_HEADING_RE = /^#{1,6}[ \t]*testing expectations\b/im;
const ANY_HEADING_RE = /^#{1,6}[ \t]+\S/m;

const PREFLIGHT_FAILURE_RE = /\*\*Dispatcher preflight failed:\*\*\s*([^\n]+)/;
const RELATION_BLOCK_REASON_RE = /blocked by unresolved relation\(s\)/i;

export const PROMOTABLE_STATES = ["Backlog", "Blocked"];

export const PROMOTION_COMMENT =
  "Auto-promoted to Ready for Agent — acceptance criteria ✓, Testing Expectations ✓, not human-only ✓, blockers resolved ✓";

/**
 * True when `description` contains a heading matching `headingRe` followed by
 * at least one non-whitespace character before the next heading (or EOF).
 */
function sectionHasContent(description, headingRe) {
  const text = description || "";
  const m = headingRe.exec(text);
  if (!m) return false;
  const after = text.slice(m.index + m[0].length);
  const nextHeading = after.search(ANY_HEADING_RE);
  const body = nextHeading === -1 ? after : after.slice(0, nextHeading);
  return body.trim().length > 0;
}

/**
 * The reason text from the most recent "**Dispatcher preflight failed:** …"
 * comment on the issue, or null if there is none. `recentComments` is an
 * array of comment bodies, oldest-to-newest.
 */
export function lastPreflightFailureReason(recentComments = []) {
  for (let i = recentComments.length - 1; i >= 0; i--) {
    const m = PREFLIGHT_FAILURE_RE.exec(recentComments[i] || "");
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * @param {object} issue - normalized issue with `stateName`, `description`,
 *   `labels`, `blockedByIds`, and (for Blocked issues) `recentComments`.
 * @param {object} ctx
 * @param {(blockerId: string) => boolean} ctx.isBlockerSatisfied
 * @returns {{ promote: boolean, reason: string }}
 */
export function evaluatePromotion(issue, ctx) {
  const { isBlockerSatisfied } = ctx;
  const labels = issue.labels || [];

  if (!PROMOTABLE_STATES.includes(issue.stateName)) {
    return { promote: false, reason: `state "${issue.stateName}" is not auto-promotable` };
  }
  if (labels.includes("human-only")) {
    return { promote: false, reason: "labeled human-only" };
  }
  // Coordination issues (execution route "none", from `type:coordination`)
  // must never auto-promote — they produce no PR. This is inference-based and
  // needs no materialized `execution:*` label; enforcing a materialized route
  // for everything else is MOV-143's scope, not MOV-142's.
  if (isCoordinationIssue(issue)) {
    return { promote: false, reason: "coordination issue — never auto-promoted (route execution:none)" };
  }
  if (!sectionHasContent(issue.description, ACCEPTANCE_HEADING_RE)) {
    return { promote: false, reason: "no non-empty acceptance-criteria section" };
  }
  if (!sectionHasContent(issue.description, TESTING_HEADING_RE)) {
    return { promote: false, reason: "no non-empty Testing Expectations section" };
  }

  const unresolved = (issue.blockedByIds || []).filter((id) => !isBlockerSatisfied(id));
  if (unresolved.length > 0) {
    return { promote: false, reason: `unresolved blocker(s): ${unresolved.join(", ")}` };
  }

  if (issue.stateName === "Blocked") {
    const reason = lastPreflightFailureReason(issue.recentComments);
    if (reason === null) {
      return {
        promote: false,
        reason: "in Blocked with no dispatcher preflight-failure comment — left for a human",
      };
    }
    if (!RELATION_BLOCK_REASON_RE.test(reason)) {
      return {
        promote: false,
        reason: `in Blocked for a non-relation reason: "${reason}"`,
      };
    }
    // Relation block, and every blocker is now resolved (checked above) -> recover it.
  }

  return {
    promote: true,
    reason: "acceptance criteria ✓, Testing Expectations ✓, not human-only ✓, blockers resolved ✓",
  };
}

/**
 * Evaluate every issue and promote the eligible ones. Returns one result per
 * issue: `{ issue, promoted, reason }`. Idempotent — an already-promoted
 * issue is no longer in `Backlog`/`Blocked`, so a second pass sees nothing;
 * the `Ready for Agent` guard is belt-and-suspenders.
 *
 * @param {object[]} issues
 * @param {object} ctx
 * @param {object} ctx.linearClient
 * @param {string} ctx.readyForAgentStateId
 * @param {(blockerId: string) => boolean} ctx.isBlockerSatisfied
 * @param {boolean} [ctx.dryRun]
 */
export async function promoteEligible(issues, ctx) {
  const { linearClient, readyForAgentStateId, isBlockerSatisfied, dryRun = false } = ctx;
  const results = [];
  for (const issue of issues) {
    if (issue.stateName === "Ready for Agent") continue;
    const verdict = evaluatePromotion(issue, { isBlockerSatisfied });
    if (verdict.promote && !dryRun) {
      await linearClient.moveToState(issue.id, readyForAgentStateId);
      await linearClient.addComment(issue.id, PROMOTION_COMMENT);
    }
    results.push({ issue: issue.identifier, promoted: verdict.promote, reason: verdict.reason });
  }
  return results;
}
