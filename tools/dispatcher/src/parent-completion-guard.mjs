// Guards and reconciles Linear parent/child (sub-issue) completion (MOV-172).
// Completion is derived solely from child workflow state, never PR text.
import { COMPLETED_BLOCKER_STATE_NAMES } from "./dependency-gate.mjs";

export const TERMINAL_CHILD_STATE_NAMES = COMPLETED_BLOCKER_STATE_NAMES;
export const COMPLETION_DRIVING_STATE_NAMES = new Set(["Done", "Released"]);

function isBlockingChild(child) {
  return !TERMINAL_CHILD_STATE_NAMES.has(child?.stateName);
}
function isCompletionDrivingChild(child) {
  return COMPLETION_DRIVING_STATE_NAMES.has(child?.stateName);
}
function childLabel(child) {
  return child?.identifier || child?.id || "unknown child";
}
function formatChildLine(child) {
  return `- ${childLabel(child)}: ${child?.stateName || "unknown"}`;
}

/** Refuse a direct terminal transition while any child remains non-terminal. */
export function assertParentCompletable(issue, children = []) {
  const blocking = (children || []).filter(isBlockingChild);
  if (blocking.length === 0) return;
  throw new Error(
    `Cannot complete ${issue?.identifier || issue?.id || "issue"}: non-terminal child sub-issue(s) still open: ${blocking.map(childLabel).join(", ")}`,
  );
}

/** Return the one idempotent correction required for a parent and its children. */
export function evaluateParentReconciliation(parent, children = []) {
  const list = children || [];
  const blocking = list.filter(isBlockingChild);
  const completionDriving = list.filter(isCompletionDrivingChild);
  const parentIsComplete = TERMINAL_CHILD_STATE_NAMES.has(parent?.stateName);
  if (blocking.length > 0) {
    if (!parentIsComplete) {
      return { action: "none", reason: `blocked by non-terminal child sub-issue(s): ${blocking.map(childLabel).join(", ")}` };
    }
    return {
      action: "reopen",
      reason: `marked "${parent.stateName}" but has non-terminal child sub-issue(s): ${blocking.map(childLabel).join(", ")}`,
      comment: [
        `**Parent completion reconciliation:** this issue is "${parent.stateName}" but still has a non-terminal child sub-issue. Parent completion is derived from child sub-issue state, never inferred from PR/commit content, so this completion looks premature -- reopening for human review.`,
        "",
        "Offending child sub-issue(s):",
        ...blocking.map(formatChildLine),
      ].join("\n"),
    };
  }
  if (completionDriving.length === 0) {
    return { action: "none", reason: "no non-terminal children, but none reached Done/Released either (e.g. only Canceled/Duplicate) -- not a basis for auto-completion" };
  }
  if (parentIsComplete) {
    return { action: "none", reason: `already "${parent.stateName}" and every child sub-issue is complete or excluded` };
  }
  return {
    action: "complete",
    reason: `all child sub-issue(s) complete: ${list.map(childLabel).join(", ")}`,
    comment: [
      "**Parent completion reconciliation:** every child sub-issue has reached a completed state -- moving this issue to Done.",
      "",
      "Child sub-issue(s):",
      ...list.map(formatChildLine),
    ].join("\n"),
  };
}

/** Apply parent reconciliation decisions; dry runs report decisions without writes. */
export async function reconcileParents(parents, ctx) {
  const { linearClient, doneStateId, needsHumanDecisionStateId, dryRun = false, logger = console } = ctx;
  const results = [];
  for (const parent of parents) {
    const verdict = evaluateParentReconciliation(parent, parent.children || []);
    if (verdict.action === "none") {
      results.push({ issue: parent.identifier, action: "none", reason: verdict.reason });
      continue;
    }
    const targetStateId = verdict.action === "complete" ? doneStateId : needsHumanDecisionStateId;
    if (!targetStateId) {
      (logger.warn || logger.log || (() => {})).call(logger, `${parent.identifier}: would ${verdict.action} but no target workflow-state id was configured`);
      results.push({ issue: parent.identifier, action: "skipped", reason: `no target workflow-state id configured for ${verdict.action}` });
      continue;
    }
    if (!dryRun) {
      await linearClient.moveToState(parent.id, targetStateId);
      await linearClient.addComment(parent.id, verdict.comment);
    }
    results.push({ issue: parent.identifier, action: verdict.action, reason: verdict.reason, comment: verdict.comment });
  }
  return results;
}
