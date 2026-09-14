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
// future breaker never contends with this one. Atomic fsync+rename with a
// `.bak` recovery copy, matching WorktreeManager's saveState.

import fs from "node:fs";
import path from "node:path";

export class CircuitBreakerStore {
  constructor(statePath) {
    if (!statePath) throw new Error("statePath is required");
    this.statePath = statePath;
  }

  load() {
    if (!fs.existsSync(this.statePath)) return {};
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    try {
      return read(this.statePath);
    } catch (primaryError) {
      try {
        return read(`${this.statePath}.bak`);
      } catch {
        throw new Error(`circuit breaker state is corrupt and no valid backup exists: ${primaryError.message}`);
      }
    }
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tempPath, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tempPath, 0o600);
    if (fs.existsSync(this.statePath)) {
      try {
        fs.copyFileSync(this.statePath, `${this.statePath}.bak`);
      } catch {
        // best-effort backup; a missing/corrupt prior file must never block a new write
      }
    }
    fs.renameSync(tempPath, this.statePath);
    try {
      const dirFd = fs.openSync(path.dirname(this.statePath), "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // directory fsync is best-effort (not supported on every filesystem)
    }
  }

  /** Is the named breaker currently open (tripped)? */
  isOpen(name) {
    return Boolean(this.load()[name]?.open);
  }

  /** Trip the named breaker. Idempotent — a repeated trip just refreshes the reason/timestamp. */
  trip(name, reason) {
    const state = this.load();
    state[name] = { open: true, reason: reason || null, trippedAt: new Date().toISOString() };
    this.save(state);
  }

  /** Clear the named breaker, e.g. once a subsequent run succeeds. A no-op when already closed. */
  clear(name) {
    const state = this.load();
    if (!state[name]?.open) return;
    state[name] = { open: false, reason: null, clearedAt: new Date().toISOString() };
    this.save(state);
  }
}
