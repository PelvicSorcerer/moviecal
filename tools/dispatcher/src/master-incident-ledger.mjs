// The durable record of every observed post-merge `master` failure (MOV-305).
//
// This file is what makes the observer idempotent across a daemon restart,
// and the ordering rule matters more than the schema: **the observation is
// persisted before any follow-up mutation.** A dispatcher that dies between
// observing a failed run and creating its remediation issue restarts holding
// a record that says "observed, nothing created yet", so the next pass
// finishes the job instead of either re-creating an issue or losing the
// incident entirely.
//
// Keying is by `masterIncidentKey()` — immutable run id, attempt, and tested
// SHA (master-ci-policy.mjs) — so re-observing the same event on every
// 30-second poll collapses onto one record, while a genuine second attempt of
// the same run is genuinely a second incident.
//
// Persisted at ~/.config/moviecal/master-incidents.json via JsonStateStore.
// Nothing here is ever deleted on completion: the original failure evidence
// outlives the remediation item that fixed it (acceptance criterion 5).

import { JsonStateStore } from "./state-store.mjs";

/** Incident lifecycle. `observed` is the persisted-before-any-mutation state. */
export const MASTER_INCIDENT_STATUSES = Object.freeze([
  "observed",
  "recorded",
  "routed",
  "needs-human-decision",
  "reconciled",
]);

export class MasterIncidentLedger extends JsonStateStore {
  get label() {
    return "master incident ledger state";
  }

  get(key) {
    return this.load()[key] || null;
  }

  all() {
    return Object.values(this.load());
  }

  /** Every incident that has not yet been reconciled, oldest observation first. */
  open() {
    return this.all()
      .filter((incident) => incident.status !== "reconciled")
      .sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
  }

  /**
   * How much automatic remediation is already outstanding. Counted across
   * incidents rather than per incident, because the thing worth bounding is
   * "how many fix branches has nobody looked at yet", not "how many times did
   * we look at this one run".
   */
  routedCount() {
    return this.all().filter((incident) => incident.status === "routed").length;
  }

  /**
   * Persist the observation itself. Idempotent by key: a repeat observation
   * refreshes only the volatile `lastObservedAt` and observation count, never
   * the original evidence or the lifecycle status.
   */
  observe(key, evidence = {}, { now = new Date() } = {}) {
    if (!key) throw new Error("observe requires an incident key");
    return this.update((state) => {
      const existing = state[key];
      if (existing) {
        existing.lastObservedAt = now.toISOString();
        existing.observationCount = (existing.observationCount || 1) + 1;
        return existing;
      }
      const incident = {
        key,
        status: "observed",
        observedAt: now.toISOString(),
        lastObservedAt: now.toISOString(),
        observationCount: 1,
        evidence: { ...evidence },
        decision: null,
        remediation: null,
        routedAt: null,
        humanDecisionAt: null,
        reconciledAt: null,
        reconciliation: null,
        history: [{ at: now.toISOString(), status: "observed" }],
      };
      state[key] = incident;
      return incident;
    });
  }

  /**
   * Fold late-arriving evidence (attribution, lineage) into an already
   * persisted observation. Separate from `observe()` so the ordering rule
   * stays visible in the call site: the run itself is recorded first, and
   * everything that needed a further GitHub read is merged in afterwards.
   */
  mergeEvidence(key, patch = {}) {
    return this.update((state) => {
      const incident = state[key];
      if (!incident) return null;
      incident.evidence = { ...incident.evidence, ...patch };
      return incident;
    });
  }

  /** Attach the decision that was taken against this observation. */
  recordDecision(key, decision, { now = new Date() } = {}) {
    return this.update((state) => {
      const incident = state[key];
      if (!incident) return null;
      incident.decision = { ...decision, at: now.toISOString() };
      return incident;
    });
  }

  /**
   * Bind the Linear remediation item to the incident. Called once, right
   * after the issue is created; a later pass reuses it rather than creating a
   * second issue for the same run.
   */
  attachRemediation(key, remediation, { now = new Date() } = {}) {
    return this.update((state) => {
      const incident = state[key];
      if (!incident) return null;
      incident.remediation = { ...remediation, createdAt: incident.remediation?.createdAt || now.toISOString() };
      if (incident.status === "observed") {
        incident.status = "recorded";
        incident.history.push({ at: now.toISOString(), status: "recorded", detail: remediation.identifier || null });
      }
      return incident;
    });
  }

  /**
   * Move the incident to a terminal-until-reconciled routing status. Both
   * statuses are recorded the same way on purpose: "we routed a fix" and "we
   * stopped for a human" are equally durable outcomes, and only one of them
   * spends budget.
   */
  setStatus(key, status, detail = null, { now = new Date() } = {}) {
    if (!MASTER_INCIDENT_STATUSES.includes(status)) throw new Error(`unknown master incident status: ${status}`);
    return this.update((state) => {
      const incident = state[key];
      if (!incident) return null;
      if (incident.status === status) return incident;
      incident.status = status;
      if (status === "routed") incident.routedAt = now.toISOString();
      if (status === "needs-human-decision") incident.humanDecisionAt = now.toISOString();
      incident.history.push({ at: now.toISOString(), status, detail });
      return incident;
    });
  }

  /**
   * Close the incident out. The evidence and the whole history stay exactly
   * where they are — reconciliation appends the proof, it never replaces the
   * record of what failed.
   */
  reconcile(key, reconciliation, { now = new Date() } = {}) {
    return this.update((state) => {
      const incident = state[key];
      if (!incident) return null;
      incident.status = "reconciled";
      incident.reconciledAt = now.toISOString();
      incident.reconciliation = { ...reconciliation };
      incident.history.push({ at: now.toISOString(), status: "reconciled", detail: reconciliation?.reason || null });
      return incident;
    });
  }

  /**
   * The open incidents a reconciliation pass should look at, least recently
   * checked first, capped at `limit`.
   *
   * The cap exists because reconciliation costs two GitHub reads per incident
   * per poll cycle, and an escalated incident stays open until a human acts —
   * so the open set does not necessarily shrink on its own. Ordering by last
   * check rather than by observation time is what keeps that cap fair: with
   * more open incidents than the cap, every one of them is still reached,
   * just over several cycles instead of one.
   */
  dueForReconciliation(limit = 10) {
    const candidates = this.open()
      .filter((incident) => incident.remediation?.identifier)
      .sort((a, b) => String(a.lastReconcileCheckAt || "").localeCompare(String(b.lastReconcileCheckAt || "")));
    return { due: candidates.slice(0, Math.max(0, limit)), deferred: Math.max(0, candidates.length - Math.max(0, limit)) };
  }

  /** Stamp when an incident was last considered for reconciliation. */
  markReconcileCheck(key, { now = new Date() } = {}) {
    return this.update((state) => {
      const incident = state[key];
      if (!incident) return null;
      incident.lastReconcileCheckAt = now.toISOString();
      return incident;
    });
  }

  /**
   * Has this exact side effect already been performed for this incident?
   * Used for the one-comment-per-transition rule, so a restart mid-pass
   * cannot produce a duplicate Linear comment.
   */
  hasEffect(key, effect) {
    return Boolean(this.get(key)?.effects?.[effect]);
  }

  markEffect(key, effect, { now = new Date() } = {}) {
    return this.update((state) => {
      const incident = state[key];
      if (!incident) return null;
      incident.effects = incident.effects || {};
      incident.effects[effect] = now.toISOString();
      return incident;
    });
  }
}
