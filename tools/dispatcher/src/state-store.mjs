// Crash-safe JSON state persisted outside the repository, under
// ~/.config/moviecal/ (see config.mjs).
//
// Three dispatcher stores now need exactly the same durability contract —
// the host-wide circuit breaker (MOV-180), the repair ledger and the
// dispatch-time usage-limit record (MOV-151) — and all three are the kind of
// state where losing a write silently converts a bounded retry into an
// unbounded one. The write is an fsync + rename transaction that retains a
// `.bak`, and a corrupt primary is recovered from that backup rather than
// being treated as "no state" (which would read as "no attempts used yet").
//
// Deliberately schema-free: each store owns its own value shape and keying.

import fs from "node:fs";
import path from "node:path";

export class JsonStateStore {
  constructor(statePath) {
    if (!statePath) throw new Error("statePath is required");
    this.statePath = statePath;
  }

  /** Human-readable name used in the corrupt-state error. Overridden per store. */
  get label() {
    return "dispatcher state";
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
        throw new Error(`${this.label} is corrupt and no valid backup exists: ${primaryError.message}`);
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

  /**
   * Read-modify-write in one call. The mutator's return value is passed
   * through, so a caller can both persist and observe the new record without
   * a second `load()`.
   */
  update(mutator) {
    const state = this.load();
    const result = mutator(state);
    this.save(state);
    return result;
  }
}
