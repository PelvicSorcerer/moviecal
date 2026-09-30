// MOV-427: bounded, disabled-by-default Jev router arm selection, admission
// ledger and rollback (MOV-422's design doc, MOV-383's worker-trial pattern).
//
// This module builds the *admission* side only: eligibility, an approved
// policy hash, a UTC expiry of at most 14 days, a hard cap of 12 new
// assignments per arm, a provider spend ceiling, early stop and attribution.
// It never selects a worker, a model, or a provider, and it never talks to
// OpenRouter/TypeSafe or any router proxy -- MOV-428/MOV-429 own that
// transport and credential work. Until then, admitting an issue here only
// records that it *would* have been routed through the named arm, for
// accounting and future wiring; `worker:*`/`model:*` routing
// (worker-routing.mjs) is completely untouched by this module.
//
// Two durable files live outside the repository, next to the worker-trial
// state:
//   - the arm *config* (enabled, trial ID, arm ID, approved policy hash,
//     explicit UTC expiry, assignment cap, spend ceiling), written only by
//     `dispatcher jev activate|stop` (or by hand); absent means disabled;
//   - the append-only *ledger*, written only by the run loop under the
//     dispatcher's singleton lock: one assignment record per distinct issue,
//     plus one spend record per distinct provider request ID.
// Early stop rewrites the config alone so it can never race a ledger write,
// and it never deletes or edits a ledger record.

import { JsonStateStore } from "./state-store.mjs";

export const MAX_TRIAL_DAYS = 14;
/** Hard cap: "max 12 new assignments per arm" (MOV-427 acceptance criteria). Not operator-raisable without a code change. */
export const MAX_ARM_ASSIGNMENTS = 12;
/** Ceiling on the operator-set spend ceiling itself, matching MOV-422's proposed $75 per-arm cap pending Adam's approval. */
export const MAX_SPEND_CEILING_USD = 75;
export const ARM_IDS = Object.freeze(["jev-hosted", "jev-oss"]);
export const JEV_STATUSES = ["disabled", "active", "expired", "exhausted", "spend-exhausted", "invalid"];
/** The label an issue must carry to be eligible; it never reinterprets worker:* or model:*. */
export const ELIGIBLE_LABEL = "router:jev";

/**
 * A policy hash (candidate list + provider constraints, hashed by the
 * operator's own tooling) must appear here before `jev activate` accepts it.
 * Deliberately empty: no router policy has been reviewed and approved yet,
 * so every activation attempt fails validation -- fail-closed by default --
 * until a human adds an approved hash here in a reviewed code change. This
 * is the "cannot activate with a missing guard" requirement from MOV-422.
 */
export const APPROVED_POLICY_HASHES = Object.freeze([]);

/**
 * Labels that make an issue ineligible even when it carries `router:jev`,
 * per MOV-422: "exclude auth, migrations, secrets, high-risk work, and
 * issues requiring human-only execution."
 */
export const EXCLUDED_LABELS = new Set([
  "human-only",
  "risk:high",
  "area:auth",
  "area:security",
  "area:database",
  "area:deployment",
  "area:migrations",
  "area:secrets",
  "security-sensitive",
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const POLICY_HASH_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:/-]{1,200}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseUtc(value) {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function labelsOf(issue) {
  return new Set((issue?.labels || []).map((label) => String(label).toLowerCase()));
}

class ConfigStore extends JsonStateStore {
  get label() {
    return "jev arm config";
  }
}
class LedgerStore extends JsonStateStore {
  get label() {
    return "jev arm assignments";
  }
}

/**
 * Validate an *enabled* arm config; returns an error string or null.
 *
 * `approvedPolicyHashes` defaults to the module-level `APPROVED_POLICY_HASHES`
 * (empty, fail-closed in production). `JevArmStore` accepts its own override
 * so tests can exercise activation, expiry, cap and spend logic against a
 * fixture hash without weakening the real default -- the *production*
 * default is what MOV-427's "cannot activate with a missing guard"
 * requirement is about, not this function's testability.
 */
export function validateJevArmConfig(config, { approvedPolicyHashes = APPROVED_POLICY_HASHES } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "jev arm config must be a JSON object";
  if (typeof config.trialId !== "string" || !TRIAL_ID_RE.test(config.trialId)) {
    return "trialId must be 1-100 characters of letters, digits, '_', '.', ':' or '-'";
  }
  if (typeof config.armId !== "string" || !ARM_IDS.includes(config.armId)) {
    return `armId must be one of: ${ARM_IDS.join(", ")}`;
  }
  if (typeof config.policyHash !== "string" || !POLICY_HASH_RE.test(config.policyHash)) {
    return "policyHash must be a 1-200 character bounded identifier";
  }
  if (!approvedPolicyHashes.includes(config.policyHash)) {
    return `policyHash '${config.policyHash}' is not in the approved policy hash list; add it to APPROVED_POLICY_HASHES in a reviewed change before activating`;
  }
  if (config.allowedWorker !== "claude") {
    return "allowedWorker must be 'claude' (Codex transport is not proved for this arm yet, MOV-429)";
  }
  const activated = parseUtc(config.activatedAt);
  if (activated === null) return "activatedAt must be an ISO-8601 UTC timestamp ending in Z";
  const expires = parseUtc(config.expiresAt);
  if (expires === null) return "expiresAt must be an explicit ISO-8601 UTC timestamp ending in Z";
  if (expires <= activated) return "expiresAt must be after activatedAt";
  if (expires - activated > MAX_TRIAL_DAYS * DAY_MS) return `expiresAt must be no more than ${MAX_TRIAL_DAYS} days after activatedAt`;
  if (!Number.isInteger(config.maxAssignments) || config.maxAssignments < 1 || config.maxAssignments > MAX_ARM_ASSIGNMENTS) {
    return `maxAssignments must be an integer from 1 to ${MAX_ARM_ASSIGNMENTS}`;
  }
  if (typeof config.spendCeilingUsd !== "number" || !Number.isFinite(config.spendCeilingUsd) || config.spendCeilingUsd <= 0 || config.spendCeilingUsd > MAX_SPEND_CEILING_USD) {
    return `spendCeilingUsd must be a positive number up to ${MAX_SPEND_CEILING_USD}`;
  }
  return null;
}

/**
 * Is `issue` eligible for the named arm? Requires the explicit opt-in label
 * (`router:jev` by default) and excludes the MOV-422 high-risk categories.
 * This never reads or changes `worker:*`/`model:*` labels.
 */
export function isEligibleForJevArm(issue, { eligibleLabel = ELIGIBLE_LABEL } = {}) {
  const labels = labelsOf(issue);
  if (!labels.has(eligibleLabel.toLowerCase())) {
    return { eligible: false, reason: `missing the '${eligibleLabel}' opt-in label` };
  }
  const excluded = [...labels].find((label) => EXCLUDED_LABELS.has(label));
  if (excluded) {
    return { eligible: false, reason: `excluded by label '${excluded}'` };
  }
  return { eligible: true, reason: null };
}

export class JevArmStore {
  constructor({ configPath, ledgerPath, approvedPolicyHashes = APPROVED_POLICY_HASHES }) {
    if (!configPath || !ledgerPath) throw new Error("configPath and ledgerPath are required");
    this.config = new ConfigStore(configPath);
    this.ledger = new LedgerStore(ledgerPath);
    this.approvedPolicyHashes = approvedPolicyHashes;
  }

  /** Every assignment record ever written, keyed by issue identifier. */
  assignments() {
    const state = this.ledger.load();
    return state.assignments && typeof state.assignments === "object" ? state.assignments : {};
  }

  /** Every spend record ever written, keyed by provider request ID. */
  spendRecords() {
    const state = this.ledger.load();
    return state.spend && typeof state.spend === "object" ? state.spend : {};
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
   * The arm's current state, evaluated against `now`. Never throws: a
   * corrupt or invalid file is reported as `status: "invalid"` with the
   * error, so callers surface it instead of silently falling back.
   */
  state(now = new Date()) {
    let config;
    let assignments;
    let spend;
    try {
      config = this.config.load();
      assignments = this.assignments();
      spend = this.spendRecords();
    } catch (error) {
      return blankState("invalid", { error: error.message });
    }
    if (!config || Object.keys(config).length === 0) return blankState("disabled");
    if (typeof config.enabled !== "boolean") return blankState("invalid", { error: "enabled must be true or false", config });
    const trialId = typeof config.trialId === "string" ? config.trialId : null;
    const assigned = trialId ? Object.values(assignments).filter((record) => record?.trialId === trialId).length : 0;
    const spent = trialId
      ? round(Object.values(spend).filter((record) => record?.trialId === trialId).reduce((sum, record) => sum + (Number(record.amountUsd) || 0), 0))
      : 0;
    const base = {
      trialId,
      armId: typeof config.armId === "string" ? config.armId : null,
      policyHash: typeof config.policyHash === "string" ? config.policyHash : null,
      enabled: config.enabled,
      activatedAt: config.activatedAt ?? null,
      expiresAt: config.expiresAt ?? null,
      stoppedAt: config.stoppedAt ?? null,
      maxAssignments: Number.isInteger(config.maxAssignments) ? config.maxAssignments : null,
      assigned,
      remaining: Number.isInteger(config.maxAssignments) ? Math.max(0, config.maxAssignments - assigned) : null,
      spendCeilingUsd: typeof config.spendCeilingUsd === "number" ? config.spendCeilingUsd : null,
      spentUsd: spent,
      spendRemainingUsd: typeof config.spendCeilingUsd === "number" ? round(Math.max(0, config.spendCeilingUsd - spent)) : null,
      error: null,
    };
    if (!config.enabled) return { ...base, status: "disabled" };
    const error = validateJevArmConfig(config, { approvedPolicyHashes: this.approvedPolicyHashes });
    if (error) return { ...base, status: "invalid", error };
    const nowMs = now.getTime();
    if (nowMs < Date.parse(config.activatedAt)) {
      return { ...base, status: "invalid", error: "activatedAt is in the future" };
    }
    if (nowMs >= Date.parse(config.expiresAt)) return { ...base, status: "expired" };
    if (assigned >= config.maxAssignments) return { ...base, status: "exhausted" };
    if (spent >= config.spendCeilingUsd) return { ...base, status: "spend-exhausted" };
    return { ...base, status: "active" };
  }

  /**
   * Admit `issue` to the arm. Must be called with the dispatcher lock held
   * (the run loop does). Re-evaluates expiry, the cap and the spend ceiling
   * from the durable files on every call. An issue already in the ledger is
   * returned as-is without consuming another slot or re-checking
   * eligibility, so a restart, retry, resume or repair of an already
   * assigned issue keeps its recorded arm and model policy unconditionally.
   */
  admit(issue, { tier, now = new Date(), eligibleLabel = ELIGIBLE_LABEL } = {}) {
    const existing = this.get(issue.identifier);
    if (existing) return { admitted: true, existing: true, record: existing, state: this.state(now), reason: null };
    const state = this.state(now);
    if (state.status !== "active") {
      return { admitted: false, existing: false, record: null, state, reason: `jev arm is ${state.status}` };
    }
    const eligibility = isEligibleForJevArm(issue, { eligibleLabel });
    if (!eligibility.eligible) {
      return { admitted: false, existing: false, record: null, state, reason: eligibility.reason };
    }
    const record = {
      trialId: state.trialId,
      armId: state.armId,
      policyHash: state.policyHash,
      issue: issue.identifier,
      worker: "claude",
      tier,
      reason: jevRoutingReason(state.trialId, state.armId),
      assignedAt: now.toISOString(),
    };
    this.ledger.update((ledger) => {
      if (!ledger.assignments || typeof ledger.assignments !== "object") ledger.assignments = {};
      ledger.assignments[issue.identifier] = record;
    });
    return { admitted: true, existing: false, record, state: this.state(now), reason: null };
  }

  /**
   * Record a provider spend attributed to this arm. Idempotent by
   * `requestId`: a retried or replayed usage report for the same request
   * never double-counts against the spend ceiling.
   */
  recordSpend({ requestId, issue, amountUsd, trialId }, now = new Date()) {
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) throw new Error("requestId must be a bounded identifier");
    if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd < 0) throw new Error("amountUsd must be a non-negative number");
    const resolvedTrialId = trialId ?? this.state(now).trialId;
    if (!resolvedTrialId) return this.state(now);
    const existing = this.spendRecords()[requestId];
    if (existing) return this.state(now);
    this.ledger.update((ledger) => {
      if (!ledger.spend || typeof ledger.spend !== "object") ledger.spend = {};
      if (ledger.spend[requestId]) return; // race-safe: another writer folded this request first
      ledger.spend[requestId] = {
        requestId,
        trialId: resolvedTrialId,
        issue: typeof issue === "string" ? issue : null,
        amountUsd: round(amountUsd),
        recordedAt: now.toISOString(),
      };
    });
    return this.state(now);
  }

  /** Enable the arm. Requires an approved policy hash, a future expiry no more than 14 days out, a cap of at most 12, and a positive spend ceiling. */
  activate({ trialId, armId, policyHash, allowedWorker = "claude", expiresAt, maxAssignments, spendCeilingUsd, now = new Date() }) {
    const config = { enabled: true, trialId, armId, policyHash, allowedWorker, activatedAt: now.toISOString(), expiresAt, maxAssignments, spendCeilingUsd };
    const error = validateJevArmConfig(config, { approvedPolicyHashes: this.approvedPolicyHashes });
    if (error) throw new Error(error);
    const expires = Date.parse(expiresAt);
    if (expires <= now.getTime()) throw new Error("expiresAt must be in the future");
    if (expires - now.getTime() > MAX_TRIAL_DAYS * DAY_MS) throw new Error(`expiresAt must be no more than ${MAX_TRIAL_DAYS} days from now`);
    const current = this.state(now);
    if (current.status === "active") throw new Error(`jev arm ${current.trialId}/${current.armId} is already active; stop it first`);
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

export function jevRoutingReason(trialId, armId) {
  return `jev-trial ${trialId}: issue admitted to router arm ${armId} (no live routing in this build)`;
}

function blankState(status, extra = {}) {
  const { config, ...rest } = extra;
  return {
    status,
    trialId: typeof config?.trialId === "string" ? config.trialId : null,
    armId: typeof config?.armId === "string" ? config.armId : null,
    policyHash: typeof config?.policyHash === "string" ? config.policyHash : null,
    enabled: false,
    activatedAt: null,
    expiresAt: null,
    stoppedAt: null,
    maxAssignments: null,
    assigned: 0,
    remaining: null,
    spendCeilingUsd: null,
    spentUsd: 0,
    spendRemainingUsd: null,
    error: null,
    ...rest,
  };
}

function round(value) {
  return Math.round(value * 1e5) / 1e5;
}

/** The attribution object recorded with the manifest, registry entry and usage record. */
export function jevAttribution(record) {
  if (!record) return null;
  return {
    trialId: record.trialId,
    armId: record.armId,
    policyHash: record.policyHash,
    worker: record.worker,
    routingReason: record.reason,
    assignedAt: record.assignedAt,
  };
}

/** One operator-facing line describing a jev arm state. */
export function describeJevState(state) {
  const counts = state.maxAssignments === null ? "" : ` — ${state.assigned}/${state.maxAssignments} assignments used, $${state.spentUsd ?? 0}/$${state.spendCeilingUsd ?? "?"} spent`;
  const arm = state.trialId ? `${state.trialId}/${state.armId ?? "?"}` : null;
  switch (state.status) {
    case "active":
      return `ACTIVE (${arm}) until ${state.expiresAt}${counts}; eligible '${ELIGIBLE_LABEL}' issues are admitted to the jev arm (no live routing yet)`;
    case "expired":
      return `EXPIRED (${arm}) at ${state.expiresAt}${counts}; new issues use fixed worker:*/model:* routing`;
    case "exhausted":
      return `EXHAUSTED (${arm})${counts}; new issues use fixed worker:*/model:* routing`;
    case "spend-exhausted":
      return `SPEND CEILING REACHED (${arm})${counts}; new issues use fixed worker:*/model:* routing`;
    case "invalid":
      return `INVALID CONFIG — ${state.error}; jev arm admission is refused until it is fixed (dispatcher jev stop disables it)`;
    default:
      return `disabled${arm ? ` (last arm ${arm}${state.stoppedAt ? `, stopped ${state.stoppedAt}` : ""}${counts})` : ""}; new issues use fixed worker:*/model:* routing`;
  }
}
