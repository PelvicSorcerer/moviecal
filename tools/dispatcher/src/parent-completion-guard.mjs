// Guards Linear parent-issue completion against the MOV-172 incident: a PR
// split into stacked/parallel PRs against one Linear issue ID (or, correctly,
// real Linear sub-issues) must never let the parent complete because "a
// merged PR mentioned it" while sibling work is still outstanding. See
// docs/operators/local-execution.md for the incident background (MOV-366's
// #366 sitting open after both split PRs merged, because neither carried a
// closing keyword) and the two structural rules this module implements:
//
//   1. A parent is never marked complete while it has a non-terminal child
//      sub-issue (`assertParentCompletable`, usable at any completion
//      write site).
//   2. Completion is derived, never inferred from PR content: a poll-cycle
//      reconciliation pass (`reconcileParentCompletion`) idempotently
//      completes a parent once every child is complete, and symmetrically
//      reopens a parent that was completed while a child was still open.
//
// Canceled/Duplicate children never block completion (they are terminal),
// but they also never drive it on their own -- a parent with only
// canceled/duplicate children does not auto-complete, since no real work
// was confirmed done.

import { COMPLETED_BLOCKER_STATE_NAMES } from "./dependency-gate.mjs";

/** Child states that count as "this child's work is actually done" -- the
 * set that must be non-empty (in addition to zero blocking children) before
 * a parent is allowed to auto-complete. Deliberately narrower than
 * `COMPLETED_BLOCKER_STATE_NAMES`: Canceled/Duplicate are terminal (so they
 * never block), but a parent whose children are *all* canceled/duplicate has
 * no completed work behind it and must not auto-complete on that basis. */
export const COMPLETING_CHILD_STATE_NAMES = new Set(["Done", "Released"]);

/** Where a wrongly-completed parent is reopened to, mirroring the existing
 * "one completion issue per PR chain" remedy in
 * docs/operators/local-execution.md (§Worktree lifecycle): "reopen it to
 * `In Review` immediately and record the remaining PR in a Linear comment." */
export const PARENT_REOPEN_STATE_NAME = "In Review";

function nonTerminalChildren(children = []) {
  return (children || []).filter((child) => !COMPLETED_BLOCKER_STATE_NAMES.has(child?.stateName));
}

function completingChildren(children = []) {
  return (children || []).filter((child) => COMPLETING_CHILD_STATE_NAMES.has(child?.stateName));
}

/**
 * Throws when `issue` has any non-terminal child sub-issue, so a completion
 * write is refused rather than silently applied. Callers own the actual
 * `moveToState` mutation; this only ever validates.
 *
 * @param {{id?: string, identifier?: string}} issue
 * @param {Array<{id?: string, identifier?: string, stateName?: string}>} children
 */
export function assertParentCompletable(issue, children = []) {
  const blocking = nonTerminalChildren(children);
  if (blocking.length === 0) return;
  const names = blocking.map((child) => child.identifier || child.id).join(", ");
  const label = issue?.identifier || issue?.id || "issue";
  throw new Error(`${label} cannot be completed while non-terminal child sub-issue(s) remain: ${names}`);
}

/**
 * Poll-cycle reconciliation pass (backstop for MOV-172): agents call Linear
 * directly, not always through dispatcher code, so a write-time guard alone
 * is unreliable. This re-derives parent completion from live child state
 * every pass, symmetrically:
 *
 *   - a non-terminal parent whose children are all terminal, with at least
 *     one actually `Done`/`Released` (not only Canceled/Duplicate) ->
 *     completed, with a comment listing every child;
 *   - a terminal parent (`Done`/`Released`/`Canceled`/`Duplicate`) with any
 *     non-terminal child -> reopened to `PARENT_REOPEN_STATE_NAME`, with a
 *     comment naming the offending child(ren).
 *
 * Idempotent: once a parent's state agrees with its children, later passes
 * are no-ops (no repeated writes or comments). Parents with no children are
 * skipped entirely -- a human who deliberately split work across multiple
 * PRs against one ID, without sub-issues, gets no automated inference at
 * all, per MOV-172's rules.
 *
 * @param {Array<{id: string, identifier?: string, stateName: string, children: Array<{id: string, identifier?: string, stateName: string}>}>} parents
 * @param {object} ctx
 * @param {object} ctx.linearClient
 * @param {string} [ctx.doneStateId] - required to actually complete a parent
 * @param {string} [ctx.reopenStateId] - required to actually reopen a parent
 * @param {boolean} [ctx.dryRun]
 * @param {{log?: Function, warn?: Function}} [ctx.logger]
 * @returns {Promise<Array<{id: string, identifier?: string, action: "completed"|"reopened"|"error", dryRun?: boolean, children?: string[], offendingChildren?: string[], error?: string}>>}
 */
export async function reconcileParentCompletion(parents, ctx) {
  const { linearClient, doneStateId, reopenStateId, dryRun = false, logger = console } = ctx;
  const results = [];

  for (const parent of parents) {
    const children = parent.children || [];
    if (children.length === 0) continue;

    const blocking = nonTerminalChildren(children);
    const parentTerminal = COMPLETED_BLOCKER_STATE_NAMES.has(parent.stateName);

    try {
      if (!parentTerminal && blocking.length === 0 && completingChildren(children).length > 0) {
        const childIdentifiers = children.map((child) => child.identifier || child.id);
        const body = `**Dispatcher parent-completion reconciliation:** every child sub-issue is complete (${childIdentifiers.join(", ")}) — completing this parent.`;
        if (!dryRun) {
          if (!doneStateId) throw new Error("no doneStateId configured");
          assertParentCompletable(parent, children);
          await linearClient.moveToState(parent.id, doneStateId);
          await linearClient.addComment(parent.id, body);
        }
        results.push({ id: parent.id, identifier: parent.identifier, action: "completed", dryRun, children: childIdentifiers });
        continue;
      }

      if (parentTerminal && blocking.length > 0) {
        const offending = blocking.map((child) => child.identifier || child.id);
        const body = `**Dispatcher parent-completion reconciliation:** this issue was marked "${parent.stateName}" but child sub-issue(s) ${offending.join(", ")} are still open — reopening for review, since a completion that happened is presumptively premature.`;
        if (!dryRun) {
          if (!reopenStateId) throw new Error("no reopenStateId configured");
          await linearClient.moveToState(parent.id, reopenStateId);
          await linearClient.addComment(parent.id, body);
        }
        results.push({ id: parent.id, identifier: parent.identifier, action: "reopened", dryRun, offendingChildren: offending });
        continue;
      }
    } catch (err) {
      (logger.warn || logger.log || (() => {})).call(
        logger,
        `${parent.identifier || parent.id}: parent-completion reconciliation failed (retrying next pass): ${err.message}`,
      );
      results.push({ id: parent.id, identifier: parent.identifier, action: "error", error: err.message });
    }
  }

  return results;
}
