// Host-wide circuit breaker for failure signatures that mean "this Mac's own
// infrastructure is broken", not "this issue's task failed" (MOV-180).
//
// Persisted outside the repo (same home as worktrees.json — see config.mjs)
// so the breaker survives a dispatcher restart: the underlying condition
// (e.g. a wedged nested-sandbox Seatbelt daemon) does not clear itself just
// because the daemon process restarted, and only a `launchctl bootout` +
// `bootstrap` of the Mac itself — a human action — actually fixes it. See
// docs/operators/local-execution.md §Security model.
//
// Named breakers share one state file (keyed by reason) so an unrelated
// future breaker never contends with this one. The atomic fsync+rename and
// `.bak` recovery live in JsonStateStore (state-store.mjs), shared with the
// repair ledger and the usage-limit record (MOV-151).

import { JsonStateStore } from "./state-store.mjs";

export class CircuitBreakerStore extends JsonStateStore {
  get label() {
    return "circuit breaker state";
  }

  /** Is the named breaker currently open (tripped)? */
  isOpen(name) {
    return Boolean(this.load()[name]?.open);
  }

  /** Trip the named breaker. Idempotent — a repeated trip just refreshes the reason/timestamp. */
  trip(name, reason) {
    this.update((state) => {
      state[name] = { open: true, reason: reason || null, trippedAt: new Date().toISOString() };
    });
  }

  /** Clear the named breaker, e.g. once a subsequent run succeeds. A no-op when already closed. */
  clear(name) {
    const state = this.load();
    if (!state[name]?.open) return;
    state[name] = { open: false, reason: null, clearedAt: new Date().toISOString() };
    this.save(state);
  }
}
