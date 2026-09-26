// MOV-383: bounded, disabled-by-default trial that temporarily sends fresh
// `worker:any` issues to Codex (the Sol-vs-Sonnet data-gathering trial).
//
// Two durable files live outside the repository, next to the other dispatcher
// state:
//   - the trial *config* (enabled, trial ID, activation time, explicit UTC
//     expiry, assignment cap), written only by `dispatcher trial activate|stop`
//     (or by hand); absent means disabled;
//   - the append-only assignment *ledger*, written only by the run loop under
//     the dispatcher's singleton lock, one record per distinct issue.
// They are separate files on purpose: early stop rewrites the config alone,
// so it can never race the run loop's ledger write, and it never deletes or
// edits a ledger record.
//
// Nothing here polls Linear or schedules anything. Expiry and the cap are
// re-evaluated from these two files each time a decision is needed.

import { JsonStateStore } from "./state-store.mjs";

export const MAX_TRIAL_DAYS = 14;
export const MAX_TRIAL_ASSIGNMENTS = 30;
export const TRIAL_STATUSES = ["disabled", "active", "expired", "exhausted", "invalid"];

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

class ConfigStore extends JsonStateStore {
  get label() {
    return "worker trial config";
  }
}
class LedgerStore extends JsonStateStore {
  get label() {
    return "worker trial assignments";
  }
}

/** Validate an *enabled* trial config; returns an error string or null. */
export function validateTrialConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "trial config must be a JSON object";
  if (typeof config.trialId !== "string" || !TRIAL_ID_RE.test(config.trialId)) {
    return "trialId must be 1-100 characters of letters, digits, '_', '.', ':' or '-'";
  }
  const activated = parseUtc(config.activatedAt);
  if (activated === null) return "activatedAt must be an ISO-8601 UTC timestamp ending in Z";
  const expires = parseUtc(config.expiresAt);
  if (expires === null) return "expiresAt must be an explicit ISO-8601 UTC timestamp ending in Z";
  if (expires <= activated) return "expiresAt must be after activatedAt";
  if (expires - activated > MAX_TRIAL_DAYS * DAY_MS) return `expiresAt must be no more than ${MAX_TRIAL_DAYS} days after activatedAt`;
  if (!Number.isInteger(config.maxAssignments) || config.maxAssignments < 1 || config.maxAssignments > MAX_TRIAL_ASSIGNMENTS) {
    return `maxAssignments must be an integer from 1 to ${MAX_TRIAL_ASSIGNMENTS}`;
  }
  return null;
}

export class WorkerTrialStore {
  constructor({ configPath, ledgerPath }) {
    if (!configPath || !ledgerPath) throw new Error("configPath and ledgerPath are required");
    this.config = new ConfigStore(configPath);
    this.ledger = new LedgerStore(ledgerPath);
  }

  /** Every assignment record ever written, keyed by issue identifier. */
  assignments() {
    const state = this.ledger.load();
    return state.assignments && typeof state.assignments === "object" ? state.assignments : {};
  }

  /** The recorded assignment for one issue, or null. Never throws. */
  get(issueIdentifier) {
    try {
      return this.assignments()[issueIdentifier] || null;
    } catch {
      return null;
    }
  }

  /**
   * The trial's current state, evaluated against `now`. Never throws: a
   * corrupt or invalid file is reported as `status: "invalid"` with the error,
   * so callers surface it instead of silently falling back.
   */
  state(now = new Date()) {
    let config;
    let assignments;
    try {
      config = this.config.load();
      assignments = this.assignments();
    } catch (error) {
      return blankState("invalid", { error: error.message });
    }
    if (!config || Object.keys(config).length === 0) return blankState("disabled");
    if (typeof config.enabled !== "boolean") return blankState("invalid", { error: "enabled must be true or false", config });
    const assigned = typeof config.trialId === "string"
      ? Object.values(assignments).filter((record) => record?.trialId === config.trialId).length
      : 0;
    const base = {
      trialId: typeof config.trialId === "string" ? config.trialId : null,
      enabled: config.enabled,
      activatedAt: config.activatedAt ?? null,
      expiresAt: config.expiresAt ?? null,
      stoppedAt: config.stoppedAt ?? null,
      maxAssignments: Number.isInteger(config.maxAssignments) ? config.maxAssignments : null,
      assigned,
      remaining: Number.isInteger(config.maxAssignments) ? Math.max(0, config.maxAssignments - assigned) : null,
      error: null,
    };
    if (!config.enabled) return { ...base, status: "disabled" };
    const error = validateTrialConfig(config);
    if (error) return { ...base, status: "invalid", error };
    const nowMs = now.getTime();
    if (nowMs < Date.parse(config.activatedAt)) {
      return { ...base, status: "invalid", error: "activatedAt is in the future" };
    }
    if (nowMs >= Date.parse(config.expiresAt)) return { ...base, status: "expired" };
    if (assigned >= config.maxAssignments) return { ...base, status: "exhausted" };
    return { ...base, status: "active" };
  }

  /**
   * Admit `issue` to the trial. Must be called with the dispatcher lock held
   * (the run loop does). Re-evaluates expiry and the cap from the durable files
   * on every call. An issue already in the ledger is returned as-is without
   * consuming another slot, so a restart or a retry can never double-count.
   */
  admit(issue, { tier, now = new Date() }) {
    const existing = this.get(issue.identifier);
    if (existing) return { admitted: true, existing: true, record: existing, state: this.state(now) };
    const state = this.state(now);
    if (state.status !== "active") return { admitted: false, existing: false, record: null, state };
    const record = {
      trialId: state.trialId,
      issue: issue.identifier,
      requestedWorker: "any",
      worker: "codex",
      tier,
      reason: trialRoutingReason(state.trialId),
      assignedAt: now.toISOString(),
    };
    this.ledger.update((ledger) => {
      if (!ledger.assignments || typeof ledger.assignments !== "object") ledger.assignments = {};
      ledger.assignments[issue.identifier] = record;
    });
    return { admitted: true, existing: false, record, state: this.state(now) };
  }

  /** Enable the trial. Requires a future expiry no more than 14 days out and a cap of at most 30. */
  activate({ trialId, expiresAt, maxAssignments, now = new Date() }) {
    const config = { enabled: true, trialId, activatedAt: now.toISOString(), expiresAt, maxAssignments };
    const error = validateTrialConfig(config);
    if (error) throw new Error(error);
    const expires = Date.parse(expiresAt);
    if (expires <= now.getTime()) throw new Error("expiresAt must be in the future");
    if (expires - now.getTime() > MAX_TRIAL_DAYS * DAY_MS) throw new Error(`expiresAt must be no more than ${MAX_TRIAL_DAYS} days from now`);
    const current = this.state(now);
    if (current.status === "active") throw new Error(`trial ${current.trialId} is already active; stop it first`);
    this.config.save(config);
    return this.state(now);
  }

  /** Disable future assignments. Keeps the config and every ledger record; running work is untouched. */
  stop({ now = new Date() } = {}) {
    let config = {};
    try {
      config = this.config.load();
    } catch {
      // A corrupt config is replaced by an explicit disabled one below.
    }
    this.config.save({ ...config, enabled: false, stoppedAt: now.toISOString() });
    return this.state(now);
  }
}

export function trialRoutingReason(trialId) {
  return `worker-trial ${trialId}: fresh worker:any routed to codex`;
}

function blankState(status, extra = {}) {
  const { config, ...rest } = extra;
  return {
    status,
    trialId: typeof config?.trialId === "string" ? config.trialId : null,
    enabled: false,
    activatedAt: null,
    expiresAt: null,
    stoppedAt: null,
    maxAssignments: null,
    assigned: 0,
    remaining: null,
    error: null,
    ...rest,
  };
}

/** The attribution object recorded with the manifest, registry entry and usage record. */
export function trialAttribution(record) {
  if (!record) return null;
  return {
    trialId: record.trialId,
    requestedWorker: record.requestedWorker,
    resolvedWorker: record.worker,
    routingReason: record.reason,
    assignedAt: record.assignedAt,
  };
}

/** One operator-facing line describing a trial state. */
export function describeTrialState(state) {
  const counts = state.maxAssignments === null ? "" : ` — ${state.assigned}/${state.maxAssignments} assignments used`;
  switch (state.status) {
    case "active":
      return `ACTIVE (${state.trialId}) until ${state.expiresAt}${counts}; fresh worker:any issues route to codex`;
    case "expired":
      return `EXPIRED (${state.trialId}) at ${state.expiresAt}${counts}; fresh worker:any issues use the claude baseline`;
    case "exhausted":
      return `EXHAUSTED (${state.trialId})${counts}; fresh worker:any issues use the claude baseline`;
    case "invalid":
      return `INVALID CONFIG — ${state.error}; worker:any dispatch is refused until it is fixed (dispatcher trial stop disables it)`;
    default:
      return `disabled${state.trialId ? ` (last trial ${state.trialId}${state.stoppedAt ? `, stopped ${state.stoppedAt}` : ""}${counts})` : ""}; fresh worker:any issues use the claude baseline`;
  }
}
