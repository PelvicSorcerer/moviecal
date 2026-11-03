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
//
// MOV-303 adds the issue-completeness gate (`issue-spec.mjs`): labels,
// project, and milestone, which nothing checked here before. It is mode-gated
// and ships as `report`, so merging it cannot strand a backlog issue that does
// not comply yet.
//
// MOV-359 adds the configured-human-owner gate (`owner-assignment.mjs`):
// Linear refuses to delegate an unassigned issue to `moviecal-dispatcher`, so
// `promoteEligible` fills a missing assignee immediately before the Ready for
// Agent transition the handoff Loop (MOV-220) reacts to. An issue that
// already has an assignee is left alone; an issue whose owner cannot be
// resolved or assigned is held out of Ready for Agent with an actionable
// reason instead of promoting unowned.

import { isCoordinationIssue } from "./execution-routing.mjs";
import { evaluateIssueSpec, formatIssueSpecMissing, DEFAULT_ISSUE_SPEC_MODE } from "./issue-spec.mjs";
import { needsOwnerAssignment } from "./owner-assignment.mjs";

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
 *   `labels`, `blockedByIds`, the issue-spec fields (`project`,
 *   `projectStatus`, `projectMilestoneCount`, `milestone`), and (for Blocked
 *   issues) `recentComments`.
 * @param {object} ctx
 * @param {(blockerId: string) => boolean} ctx.isBlockerSatisfied
 * @param {"off"|"report"|"enforce"} [ctx.issueSpecMode] - MOV-303. `off`
 *   ignores the completeness contract entirely; `report` (the default)
 *   promotes exactly as before and returns the violations for the caller to
 *   log; `enforce` refuses to promote an incomplete issue and names every
 *   missing item in the reason.
 * @returns {{ promote: boolean, reason: string, specViolations: string[] }}
 */
export function evaluatePromotion(issue, ctx) {
  const { isBlockerSatisfied, issueSpecMode = DEFAULT_ISSUE_SPEC_MODE } = ctx;
  const labels = issue.labels || [];

  // MOV-303: evaluated for every issue this pass sees, whatever the mode and
  // whatever the verdict below — `report` mode's whole purpose is to surface
  // violations on issues that still promote, so this cannot hang off the
  // enforcement branch.
  const spec = issueSpecMode === "off" ? { missing: [] } : evaluateIssueSpec(issue);
  const specViolations = spec.missing.map((item) => item.message);

  if (!PROMOTABLE_STATES.includes(issue.stateName)) {
    return { promote: false, reason: `state "${issue.stateName}" is not auto-promotable`, specViolations };
  }
  if (labels.includes("human-only")) {
    return { promote: false, reason: "labeled human-only", specViolations };
  }
  // Coordination issues (execution route "none", from `type:coordination`)
  // must never auto-promote — they produce no PR. This is inference-based and
  // needs no materialized `execution:*` label; enforcing a materialized route
  // for everything else is MOV-143's scope, not MOV-142's.
  if (isCoordinationIssue(issue)) {
    return {
      promote: false,
      reason: "coordination issue — never auto-promoted (route execution:none)",
      specViolations,
    };
  }
  if (!sectionHasContent(issue.description, ACCEPTANCE_HEADING_RE)) {
    return { promote: false, reason: "no non-empty acceptance-criteria section", specViolations };
  }
  if (!sectionHasContent(issue.description, TESTING_HEADING_RE)) {
    return { promote: false, reason: "no non-empty Testing Expectations section", specViolations };
  }

  // MOV-303: the completeness gate. In `enforce` mode an issue that is not
  // fully specced does not reach the dispatch queue at all, and the reason
  // names every missing item so a human can fix them in one pass rather than
  // one bounce per field. In `report` mode this branch is skipped entirely and
  // promotion behaves exactly as it did before — the violations still ride
  // back on the result for the caller to log.
  if (issueSpecMode === "enforce" && specViolations.length > 0) {
    return {
      promote: false,
      reason: `incomplete issue spec (MOV-303): ${formatIssueSpecMissing(spec.missing)}`,
      specViolations,
    };
  }

  const unresolved = (issue.blockedByIds || []).filter((id) => !isBlockerSatisfied(id));
  if (unresolved.length > 0) {
    return { promote: false, reason: `unresolved blocker(s): ${unresolved.join(", ")}`, specViolations };
  }

  if (issue.stateName === "Blocked") {
    const reason = lastPreflightFailureReason(issue.recentComments);
    if (reason === null) {
      return {
        promote: false,
        reason: "in Blocked with no dispatcher preflight-failure comment — left for a human",
        specViolations,
      };
    }
    if (!RELATION_BLOCK_REASON_RE.test(reason)) {
      return {
        promote: false,
        reason: `in Blocked for a non-relation reason: "${reason}"`,
        specViolations,
      };
    }
    // Relation block, and every blocker is now resolved (checked above) -> recover it.
  }

  return {
    promote: true,
    reason: "acceptance criteria ✓, Testing Expectations ✓, not human-only ✓, blockers resolved ✓",
    specViolations,
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
 * @param {"off"|"report"|"enforce"} [ctx.issueSpecMode] - MOV-303; see
 *   `evaluatePromotion`. Each result carries `specViolations` so the caller
 *   can log them, which is all `report` mode does with them.
 * @param {{ensureOwner: Function}} [ctx.ownerAssignment] - MOV-359; see
 *   `owner-assignment.mjs`'s `createOwnerAssigner`. Omitted entirely (as
 *   every pre-MOV-359 caller does), no issue is ever checked for an
 *   assignee, and behavior is byte-identical to before. When supplied, it is
 *   consulted only for an issue `evaluatePromotion` already says is
 *   promotable and that has no assignee yet — never for one that is
 *   ineligible for an unrelated reason, and never for one that already has
 *   an owner.
 */
export async function promoteEligible(issues, ctx) {
  const { linearClient, readyForAgentStateId, isBlockerSatisfied, dryRun = false, issueSpecMode, ownerAssignment } = ctx;
  const results = [];
  for (const issue of issues) {
    if (issue.stateName === "Ready for Agent") continue;
    const verdict = evaluatePromotion(issue, { isBlockerSatisfied, issueSpecMode });
    if (!verdict.promote) {
      results.push({
        issue: issue.identifier,
        promoted: false,
        reason: verdict.reason,
        specViolations: verdict.specViolations || [],
      });
      continue;
    }

    // MOV-359: fill a missing assignee *before* the Ready for Agent
    // transition below — never after, or the handoff Loop could see the
    // transition and try to delegate an issue Linear would still reject as
    // unowned. An issue that already has one never reaches `ensureOwner` at
    // all, so a repeated pass never re-writes or re-comments.
    let ownerOutcome = null;
    if (ownerAssignment && needsOwnerAssignment(issue)) {
      ownerOutcome = await ownerAssignment.ensureOwner(issue, { dryRun });
      if (!ownerOutcome.ok) {
        results.push({
          issue: issue.identifier,
          promoted: false,
          reason: `owner assignment: ${ownerOutcome.reason}`,
          specViolations: verdict.specViolations || [],
        });
        continue;
      }
    }

    if (!dryRun) {
      await linearClient.moveToState(issue.id, readyForAgentStateId);
      await linearClient.addComment(issue.id, PROMOTION_COMMENT);
    }
    results.push({
      issue: issue.identifier,
      promoted: true,
      reason: verdict.reason,
      specViolations: verdict.specViolations || [],
      // Present only when an assignment was actually attempted this pass —
      // omitted (not merely false) when `ownerAssignment` was never supplied
      // or the issue already had an owner, so every caller that predates
      // MOV-359 sees the exact same result shape it always has.
      ...(ownerOutcome
        ? {
            ownerAssigned: Boolean(ownerOutcome.assigned),
            ownerPlanned: Boolean(ownerOutcome.wouldAssign),
            ownerName: ownerOutcome.member ? ownerOutcome.member.name : null,
          }
        : {}),
    });
  }
  return results;
}
