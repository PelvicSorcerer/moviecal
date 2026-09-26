import { JsonStateStore } from "./state-store.mjs";

export const WORKERS = ["claude", "codex"];

// Independent, durable gates for the two provider quota pools.
export class WorkerCooldownStore extends JsonStateStore {
  get label() {
    return "worker cooldown state";
  }

  get(worker) {
    return this.load()[worker] || null;
  }

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

  clear(worker) {
    const state = this.load();
    if (!state[worker]) return;
    delete state[worker];
    this.save(state);
  }

  // Future reset: wait. Elapsed reset: admit one probe. Bad reset: no invented wait.
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
