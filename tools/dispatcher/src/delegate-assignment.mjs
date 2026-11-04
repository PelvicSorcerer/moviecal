// Dispatcher delegate assignment before promoter handoff (MOV-508).
//
// The dispatcher claims an issue only when it carries exactly one
// `execution:mac` route label AND is delegated to `moviecal-dispatcher`
// (dispatch-eligibility.mjs). The handoff Loop (MOV-220) that used to set that
// delegate can no longer do so, so the promoter sets it itself, right after the
// MOV-359 owner step and before the Ready for Agent write. Linear refuses to
// delegate an unowned issue, hence the ordering.
//
// Narrow by design:
//   - only an issue with exactly one route label, `execution:mac`, whose
//     route validates, and with no delegate at all;
//   - an existing delegate (the dispatcher or anyone else) is never touched;
//   - it only runs for an issue the promoter would promote, because
//     `promoteEligible` calls in after `evaluatePromotion` says yes.
//
// A write is trusted only after the readback names the expected actor. No
// caching: a fresh assigner is built each pass so failures retry next poll.

import { parseExecutionLabels, resolveExecutionRoute } from "./execution-routing.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` looks like a Linear actor UUID rather than an app name. */
export function isActorUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}


/** True when the promoter should set the dispatcher delegate on `issue`. */
export function needsDelegateAssignment(issue) {
  if (!issue) return false;
  if (issue.delegate && (issue.delegate.id || issue.delegate.name || issue.delegate.displayName)) return false;
  const labels = parseExecutionLabels(issue.labels || []);
  if (labels.length !== 1 || labels[0] !== "execution:mac") return false;
  const route = resolveExecutionRoute(issue);
  return route.ok && route.route === "mac";
}

/**
 * @param {object} args
 * @param {object} args.linearClient
 * @param {{id?: string|null, name?: string}} args.delegate - from `resolveDispatcherDelegate()`.
 *   `id` may be the actor UUID or (as on the Mac) the app name; a non-UUID
 *   value, or none, is resolved to the UUID through `linearClient.appActorByName`
 *   using that value, falling back to `delegate.name`. A failed or ambiguous
 *   lookup holds every issue needing a delegate with an actionable reason.
 *   A successful resolution is cached for the life of this assigner.
 */
export function createDelegateAssigner({ linearClient, delegate }) {
  const label = (delegate && delegate.name) || "moviecal-dispatcher";
  const configured = delegate && delegate.id ? String(delegate.id).trim() : "";
  let resolved = isActorUuid(configured) ? configured : "";

  async function resolveActorId() {
    if (resolved) return { id: resolved };
    const lookupName = configured || label;
    if (!linearClient || typeof linearClient.appActorByName !== "function") {
      return { id: null, reason: `cannot resolve actor id for "${lookupName}": no lookup available` };
    }
    let found;
    try {
      found = await linearClient.appActorByName(lookupName);
    } catch (error) {
      return { id: null, reason: `looking up actor id for "${lookupName}" failed: ${error && error.message ? error.message : error}` };
    }
    if (!found || !isActorUuid(found.id)) {
      return { id: null, reason: `could not resolve actor id for "${lookupName}"${found && found.reason ? ` (${found.reason})` : ""}; set LINEAR_APP_ACTOR_ID to the actor UUID` };
    }
    resolved = String(found.id).trim();
    return { id: resolved };
  }

  return {
    /**
     * @param {object} issue - must already satisfy `needsDelegateAssignment`.
     * @param {{ dryRun?: boolean }} [opts]
     * @returns {Promise<{ ok: boolean, reason?: string, delegated: boolean, wouldDelegate: boolean }>}
     */
    async ensureDelegate(issue, { dryRun = false } = {}) {
      const fail = (reason) => ({ ok: false, reason, delegated: false, wouldDelegate: false });
      const actor = await resolveActorId();
      if (!actor.id) return fail(`cannot delegate to ${label}: ${actor.reason}`);
      const actorId = actor.id;
      if (dryRun) return { ok: true, delegated: false, wouldDelegate: true };

      let result;
      try {
        result = await linearClient.delegateIssue(issue.id, actorId);
      } catch (error) {
        return fail(`delegation to ${label} failed for ${issue.identifier || issue.id}: ${error && error.message ? error.message : error}`);
      }
      if (!result || !result.success || result.delegateId !== actorId) {
        return fail(`delegation to ${label} for ${issue.identifier || issue.id} did not verify on readback`);
      }
      return { ok: true, delegated: true, wouldDelegate: false };
    },
  };
}
