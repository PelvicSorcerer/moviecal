// Worker-quota-pool dispatch cooldown (MOV-360).
//
// usage-limit.mjs already gives a single issue one bounded, reset-bearing
// retry (or MOV-205 resume) when its worker hits a provider usage limit. What
// it never did is stop the *next* issue pinned to the same worker from
// claiming the concurrency slot that failure just freed and immediately
// hitting the identical refusal -- the 2026-09-25 incident this issue is
// named for: five Claude issues, each individually deferred correctly, still
// burned through most of the Ready for Agent queue one at a time before the
// provider's own five-hour window reset.
//
// This store answers a different, worker-scoped question than
// UsageLimitStore's: not "should dispatch of *this issue* wait", but "is
// *this worker's* provider quota known to be exhausted right now" --
// independent of which issue discovered or eventually resolves that. It is
// deliberately not a generalization of UsageLimitStore: that store's unit is
// one issue's bounded-retry history (and, via its own `worker` field, which
// worker a `worker:any` issue's in-flight attempt is bound to); this store's
// unit is one worker's dispatch-wide gate. run-loop.mjs is what keeps the two
// in sync -- see its MOV-360 sections.
//
// Persisted outside the repo (config.mjs) so a cooldown survives a dispatcher
// restart: the provider's own reset clock does not reset just because the
// daemon did.

import { JsonStateStore } from "./state-store.mjs";

/** The two worker quota pools this dispatcher currently knows how to gate. */
export const WORKERS = ["claude", "codex"];

export class WorkerCooldownStore extends JsonStateStore {
  get label() {
    return "worker cooldown state";
  }

  get(worker) {
    return this.load()[worker] || null;
  }

  /**
   * Set or refresh `worker`'s cooldown to a newly reported reset instant.
   *
   * Idempotent in the sense every caller needs: a repeated call -- a second
   * recognized limit before the first reset arrives, or a new one discovered
   * by the post-reset probe attempt -- simply replaces the record with the
   * newly reported reset. That *is* "refreshes its cooldown to the newly
   * reported reset" (see the MOV-360 acceptance criteria); there is no
   * separate "extend" semantics to get wrong.
   */
  record(worker, { resetAt, evidence = null, now = new Date() } = {}) {
    return this.update((state) => {
      const record = {
        worker,
        resetAt,
        evidence,
        recordedAt: state[worker]?.recordedAt || now.toISOString(),
        updatedAt: now.toISOString(),
      };
      state[worker] = record;
      return record;
    });
  }

  /**
   * Close `worker`'s cooldown. Called whenever a dispatch attempt for that
   * worker proves the quota constraint is no longer what is stopping it -- a
   * clean session, or any other outcome that is not itself a newly recognized
   * usage limit. A no-op when already closed.
   */
  clear(worker) {
    const state = this.load();
    if (!state[worker]) return;
    delete state[worker];
    this.save(state);
  }

  /**
   * Live dispatch-gating state for `worker`.
   *
   *   cooling: true    -- the reported reset is still in the future. No
   *                        dispatch of this worker and no probe; per MOV-360
   *                        this is held back silently, exactly like
   *                        UsageLimitStore's per-issue deferral.
   *   probeOwed: true   -- the reset has passed but no post-reset attempt has
   *                        yet told this store the outcome. Exactly one
   *                        dispatch of this worker may be admitted as that
   *                        probe (run-loop.mjs's batch-level selection);
   *                        every other same-worker issue keeps waiting.
   *   neither           -- no unresolved cooldown; this worker dispatches
   *                        normally.
   *
   * A record whose `resetAt` cannot be parsed reads as no cooldown at all.
   * That case should never actually arise -- run-loop.mjs only ever calls
   * `record()` with a reset a recognized usage-limit classification already
   * validated -- but reading it as "open" rather than "cooling forever" keeps
   * this store fail-open on its own malformed state, matching the
   * "never invent or mask a reset" rule (MOV-360 acceptance criteria) instead
   * of the fail-closed posture that would strand a worker on bad state no
   * human ever wrote.
   */
  state(worker, now = new Date()) {
    const record = this.get(worker);
    if (!record?.resetAt) {
      return { worker, cooling: false, probeOwed: false, resetAt: null, evidence: null };
    }
    const reset = new Date(record.resetAt);
    if (Number.isNaN(reset.getTime())) {
      return { worker, cooling: false, probeOwed: false, resetAt: null, evidence: null };
    }
    if (now.getTime() < reset.getTime()) {
      return { worker, cooling: true, probeOwed: false, resetAt: record.resetAt, evidence: record.evidence };
    }
    return { worker, cooling: false, probeOwed: true, resetAt: record.resetAt, evidence: record.evidence };
  }
}
