// Configured human-owner assignment before promoter handoff (MOV-359).
//
// Linear refuses to delegate an issue to `moviecal-dispatcher` until a
// workspace member owns it: "moviecal-dispatcher works on behalf of a
// person. Assign a workspace member to the issue first, then delegate." The
// promoter (`promoter.mjs`) is the only writer that moves an issue into
// Ready for Agent (MOV-129), and the handoff Loop (MOV-220) delegates on
// exactly that transition, so the promoter is also the only place that can
// guarantee an assignee lands before it — assigning anywhere else would race
// the same transition this unblocks.
//
// Ownership assignment here is narrowly scoped, preserving the "nothing is
// ever auto-filled" boundary documented in
// docs/governance/linear-information-architecture.md §Issue completeness
// contract for every other field:
//   - it only ever fills a *missing* assignee — an issue that already has
//     one (human or otherwise) is never touched;
//   - the assignee is always the single operator-configured human
//     (`MOVIECAL_DEFAULT_OWNER_EMAIL`), never inferred from the issue
//     creator or any other heuristic;
//   - it never assigns an app/bot workspace user;
//   - it only runs on an issue the promoter would otherwise promote
//     unchanged — an unready, `human-only`, coordination, or
//     unresolved-blocker issue never reaches this module at all, because
//     `promoteEligible` (promoter.mjs) only calls in after `evaluatePromotion`
//     says yes.
//
// Pure decision logic lives here (`needsOwnerAssignment`,
// `evaluateOwnerCandidate`); `createOwnerAssigner` is the thin I/O
// orchestrator `promoter.mjs`/`bin/dispatcher.mjs` wires a real
// `LinearClient` into — the same split `promoter.mjs` itself uses.
//
// Deliberately no caching of the workspace-member lookup: a transient lookup
// or write failure must be retryable on the very next poll cycle with no
// special-cased recovery, and a fresh `createOwnerAssigner` is built at the
// start of every promote pass anyway (`cmdPromoteOnce`), so nothing would
// outlive one pass to cache.

/** True when `issue` has no assignee, and so needs one before it can promote. */
export function needsOwnerAssignment(issue) {
  return !(issue && issue.assignee && issue.assignee.id);
}

/**
 * Validate a workspace member (as normalized by
 * `LinearClient.workspaceMemberByEmail`) as the configured owner for
 * `teamKey`. `member` is `null` when the lookup found nobody with that
 * email.
 *
 * @param {object|null} member
 * @param {{ teamKey?: string, ownerEmail: string }} ctx
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluateOwnerCandidate(member, { teamKey, ownerEmail }) {
  if (!member) {
    return { ok: false, reason: `configured owner "${ownerEmail}" was not found in the Linear workspace` };
  }
  if (member.active === false) {
    return { ok: false, reason: `configured owner "${ownerEmail}" is not an active workspace member` };
  }
  if (member.isApp) {
    return { ok: false, reason: `configured owner "${ownerEmail}" is an app/bot user, not a human` };
  }
  if (teamKey && Array.isArray(member.teamKeys) && !member.teamKeys.includes(teamKey)) {
    return { ok: false, reason: `configured owner "${ownerEmail}" has no access to team "${teamKey}"` };
  }
  return { ok: true };
}

/**
 * Build the I/O orchestrator `promoter.mjs`'s `promoteEligible` calls to fill
 * a missing assignee.
 *
 * @param {object} args
 * @param {object} args.linearClient
 * @param {string} [args.teamKey]
 * @param {string|null} args.ownerEmail - the resolved
 *   `MOVIECAL_DEFAULT_OWNER_EMAIL` value, or `null`/empty when unconfigured —
 *   every issue that needs an owner then fails closed with that reason,
 *   without a network call.
 */
export function createOwnerAssigner({ linearClient, teamKey, ownerEmail }) {
  return {
    /**
     * @param {object} issue - must already be known to need an owner
     *   (`needsOwnerAssignment(issue)`); this function does not re-check.
     * @param {{ dryRun?: boolean }} [opts]
     * @returns {Promise<{ ok: boolean, reason?: string, assigned: boolean, wouldAssign: boolean, member: object|null }>}
     */
    async ensureOwner(issue, { dryRun = false } = {}) {
      const email = String(ownerEmail || "").trim();
      if (!email) {
        return {
          ok: false,
          reason: "no default owner configured (MOVIECAL_DEFAULT_OWNER_EMAIL is unset)",
          assigned: false,
          wouldAssign: false,
          member: null,
        };
      }

      const member = await linearClient.workspaceMemberByEmail(email);
      const verdict = evaluateOwnerCandidate(member, { teamKey, ownerEmail: email });
      if (!verdict.ok) {
        return { ok: false, reason: verdict.reason, assigned: false, wouldAssign: false, member: null };
      }

      if (dryRun) {
        return { ok: true, assigned: false, wouldAssign: true, member };
      }

      const result = await linearClient.assignIssue(issue.id, member.id);
      if (!result || !result.success || result.assigneeId !== member.id) {
        return {
          ok: false,
          reason: `assignment of "${email}" to ${issue.identifier || issue.id} did not verify on readback`,
          assigned: false,
          wouldAssign: false,
          member: null,
        };
      }

      return { ok: true, assigned: true, wouldAssign: false, member };
    },
  };
}
