// The durable record of what automatic repair has already tried (MOV-151).
//
// Two properties depend entirely on this file existing and surviving a
// restart, and both are the difference between "bounded" and "a loop":
//
//   - **At most one repair job per head SHA and failure fingerprint.** A
//     30-second poll loop sees the same failing PR over and over. Without a
//     reserved key, every cycle would look like a fresh trigger.
//   - **A budget that can actually be exhausted.** Attempts are counted per
//     PR, across head SHAs, because a published repair *creates* a new head
//     SHA — counting per SHA would reset the budget on every attempt it was
//     supposed to be bounding.
//
// An attempt is reserved *before* the worker starts and completed after, so a
// dispatcher that dies mid-repair leaves an `in-progress` record behind. That
// record is deliberately not self-healing: the next pass sees it, refuses to
// start a second worker against the same failure, and escalates once. A
// crashed repair is exactly the situation where guessing is worst.
//
// Persisted at ~/.config/moviecal/repair-ledger.json via JsonStateStore.

import { createHash } from "node:crypto";
import { JsonStateStore } from "./state-store.mjs";

export const REPAIR_KINDS = Object.freeze(["code-repair", "infrastructure-rerun", "escalation"]);

/** Attempt outcomes. `in-progress` is the reserved-but-unfinished state above. */
export const REPAIR_OUTCOMES = Object.freeze(["in-progress", "published", "failed", "escalated", "reran"]);

/**
 * The idempotency key for one repair job: the PR, the exact head SHA it was
 * decided against, the kind of action, and a digest of the failure
 * fingerprints that triggered it.
 *
 * Including the fingerprints is what makes a *changing* failure a new job —
 * the same SHA failing a different way is genuinely different work — while a
 * repeated observation of the same failure collapses onto one key.
 */
export function repairJobKey({ prNumber, headSha, kind, fingerprints = [] } = {}) {
  if (!prNumber || !headSha || !kind) {
    throw new Error("repairJobKey requires prNumber, headSha, and kind");
  }
  const digest = createHash("sha256")
    .update([...fingerprints].map(String).sort().join("|"))
    .digest("hex")
    .slice(0, 12);
  return `repair:${prNumber}:${headSha}:${kind}:${digest}`;
}

export class RepairLedger extends JsonStateStore {
  get label() {
    return "repair ledger state";
  }

  /** Every recorded attempt for one issue, oldest first. */
  attempts(issueId) {
    return this.load()[issueId]?.attempts || [];
  }

  /**
   * Attempt counts in the shape `decideCiOutcome`'s `previousAttempts`
   * expects, scoped to one PR so a reused issue identifier (a second PR after
   * the first was closed) starts from a clean budget.
   *
   * Escalations are not attempts: they consumed no agent or CI budget, and
   * counting them would let a single "we stopped for a human" record silently
   * spend the repair budget it was reporting on.
   */
  previousAttempts(issueId, prNumber) {
    const relevant = this.attempts(issueId).filter(
      (attempt) => attempt.prNumber === prNumber && attempt.kind !== "escalation",
    );
    return {
      codeRepair: relevant.filter((attempt) => attempt.kind === "code-repair").length,
      infrastructureRerun: relevant.filter((attempt) => attempt.kind === "infrastructure-rerun").length,
      total: relevant.length,
    };
  }

  /** Has this exact job (PR + SHA + kind + fingerprints) already been reserved? */
  has(issueId, key) {
    return this.attempts(issueId).some((attempt) => attempt.key === key);
  }

  find(issueId, key) {
    return this.attempts(issueId).find((attempt) => attempt.key === key) || null;
  }

  /** Any attempt reserved but never completed — i.e. a dispatcher that died mid-repair. */
  unfinished(issueId, prNumber) {
    return (
      this.attempts(issueId).find(
        (attempt) => attempt.prNumber === prNumber && attempt.outcome === "in-progress",
      ) || null
    );
  }

  /**
   * Reserve one attempt. Must be called *before* any worker or CI mutation,
   * so a crash between here and `complete()` is recoverable as a refusal
   * rather than as an unbounded retry.
   */
  reserve(issueId, { key, kind, prNumber, headSha, fingerprints = [], reason = null, now = new Date() } = {}) {
    if (!key) throw new Error("reserve requires a job key");
    if (!REPAIR_KINDS.includes(kind)) throw new Error(`unknown repair kind: ${kind}`);
    return this.update((state) => {
      const record = state[issueId] || { issue: issueId, attempts: [] };
      const existing = record.attempts.find((attempt) => attempt.key === key);
      if (existing) return existing;
      const attempt = {
        key,
        kind,
        prNumber,
        headSha,
        fingerprints: [...fingerprints],
        reason,
        outcome: "in-progress",
        startedAt: now.toISOString(),
        endedAt: null,
        detail: null,
      };
      record.attempts.push(attempt);
      state[issueId] = record;
      return attempt;
    });
  }

  /** Close out a reserved attempt with what actually happened. */
  complete(issueId, key, { outcome, detail = null, headSha = undefined, now = new Date() } = {}) {
    if (!REPAIR_OUTCOMES.includes(outcome)) throw new Error(`unknown repair outcome: ${outcome}`);
    return this.update((state) => {
      const attempt = state[issueId]?.attempts?.find((candidate) => candidate.key === key);
      if (!attempt) return null;
      attempt.outcome = outcome;
      attempt.detail = detail;
      attempt.endedAt = now.toISOString();
      if (headSha !== undefined) attempt.resultHeadSha = headSha;
      return attempt;
    });
  }

  /**
   * Record a terminal escalation in one write. Escalations are recorded so
   * the same stopping reason is published to Linear once rather than on every
   * poll cycle; they never consume repair budget (see `previousAttempts`).
   */
  recordEscalation(issueId, { key, prNumber, headSha, fingerprints = [], reason, now = new Date() } = {}) {
    this.reserve(issueId, { key, kind: "escalation", prNumber, headSha, fingerprints, reason, now });
    return this.complete(issueId, key, { outcome: "escalated", detail: reason, now });
  }

  /** Drop an issue's whole history, e.g. once its PR merges and the worktree is cleaned up. */
  forget(issueId) {
    const state = this.load();
    if (!state[issueId]) return;
    delete state[issueId];
    this.save(state);
  }
}
