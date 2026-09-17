// MOV-166: the live-attempt lookup an inbound Agent Session signal needs to
// find the right StopController for the issue it names, and (via an
// optional `queuePrompt` field a future consumer may attach) somewhere to
// hand a trusted follow-up prompt.
//
// A `Map` rather than a single slot: `run-loop.mjs` supports a configurable
// concurrency limit (MOV-138), so more than one `processIssue` can be running
// at once even though today's default is 1. Keyed by Linear issue id, since
// that's what an Agent Session webhook payload names.
//
// A signal for an issue with no registered entry is a completely normal case
// (no attempt is running for that issue right now) -- callers look it up,
// get `undefined`, and fall back to whatever "no active attempt" behavior is
// appropriate (record-only publication, or simply nothing). This registry
// never throws and never itself decides fallback behavior.

const registry = new Map();

/**
 * Register (or replace) the active-attempt entry for one issue.
 *
 * @param {string} issueId
 * @param {{identifier: string, controller: object, publisher?: object, queuePrompt?: (text: string) => void}} entry
 */
export function registerActiveAttempt(issueId, entry) {
  if (!issueId) return;
  registry.set(issueId, entry);
}

/**
 * Merge new fields onto an already-registered entry (e.g. attaching
 * `queuePrompt` once a live-steering-capable worker is actually running,
 * which may happen after the entry is first registered with just a
 * controller). A no-op if nothing is registered for this issue.
 */
export function updateActiveAttempt(issueId, patch) {
  if (!issueId) return;
  const existing = registry.get(issueId);
  if (!existing) return;
  registry.set(issueId, { ...existing, ...patch });
}

export function unregisterActiveAttempt(issueId) {
  if (!issueId) return;
  registry.delete(issueId);
}

export function activeAttempt(issueId) {
  if (!issueId) return null;
  return registry.get(issueId) || null;
}

/** Test-only: clear every registered entry. */
export function clearActiveAttempts() {
  registry.clear();
}
