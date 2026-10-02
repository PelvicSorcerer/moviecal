// MOV-437: operator-reviewed, disabled-by-default production cohort. The
// owner-owned approval is bound to the complete policy, including both lists
// of preselected issues and the account safeguards. No proof fixture can
// authorize this store.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { JsonStateStore } from "./state-store.mjs";
import { EXCLUDED_LABELS } from "./jev-trial.mjs";

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ISSUE = /^MOV-[1-9]\d{0,5}$/;
const ID = /^[A-Za-z0-9_.:/-]{1,200}$/;
const MODEL_ALIAS = /^~?[A-Za-z0-9_.:/-]{1,200}$/;
const SHA = /^[a-f0-9]{64}$/;
const MONEY = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 75;
const BALANCE = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e9;
const iso = (s) => typeof s === "string" && UTC.test(s) && Number.isFinite(Date.parse(s));
const round = (n) => Math.round(n * 1e6) / 1e6;

export function policyDigest(policy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function validateCohortPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return "cohort policy missing";
  if (!ID.test(policy.trialId || "") || policy.route !== "codex-openrouter-responses") return "invalid trial identity or route";
  if (!iso(policy.activatedAt) || !iso(policy.expiresAt) || Date.parse(policy.expiresAt) <= Date.parse(policy.activatedAt)
    || Date.parse(policy.expiresAt) - Date.parse(policy.activatedAt) > 14 * 86400000) return "cohort UTC window exceeds 14 days";
  const pairs = policy.pairs;
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 12
    || pairs.some((p) => !ISSUE.test(p?.routed || "") || !ISSUE.test(p?.control || "") || p.routed === p.control)
    || new Set(pairs.flatMap((p) => [p.routed, p.control])).size !== pairs.length * 2) return "cohort requires 1-12 distinct preselected pairs";
  const control = policy.control;
  if (!control || control.worker !== "codex" || !ID.test(control.model || "") || control.model === "typesafe/jev-router"
    || !ID.test(control.provider || "") || !["low", "medium", "high", "xhigh", "max"].includes(control.effort)
    || !["cheap", "default", "strong"].includes(control.tier)) return "fixed control identity is invalid";
  if (policy.routed?.model !== "typesafe/jev-router" || policy.routed?.worker !== "codex"
    || policy.routed?.tier !== control.tier) return "Jev route identity or matched tier is invalid";
  if (!ID.test(policy.keyId || "") || !ID.test(policy.workspaceId || "") || policy.keyLimitUsd !== 69
    || policy.allInCeilingUsd !== 75 || !MONEY(policy.priorOutlayUsd)
    || !MONEY(policy.baselineKeyUsageUsd) || !MONEY(policy.purchaseFeesUsd)
    || policy.priorOutlayUsd + policy.purchaseFeesUsd > 75) return "account or prior outlay basis is invalid";
  if (!policy.modelAliases || typeof policy.modelAliases !== "object" || Array.isArray(policy.modelAliases)
    || !Object.keys(policy.modelAliases).length || Object.keys(policy.modelAliases).length > 5000
    || Object.entries(policy.modelAliases).some(([alias, model]) => !MODEL_ALIAS.test(alias) || !MODEL_ALIAS.test(model))) return "reviewed model aliases missing";
  if (!Object.hasOwn(policy.modelAliases, control.model) && !Object.values(policy.modelAliases).includes(control.model)) return "control model has no reviewed canonical alias";
  return null;
}

export function validateCohortApproval(policy, approval, now = new Date()) {
  const invalid = validateCohortPolicy(policy);
  if (invalid) return invalid;
  if (!approval || approval.issue !== "MOV-431" || approval.owner !== "Adam Moore"
    || approval.ownerApproved !== true || approval.securityReviewPassed !== true
    || approval.accountPolicyReviewed !== true || approval.effectiveEligibilityUnrestricted !== true
    || approval.promptLoggingOff !== true || approval.zdrOff !== true || approval.dataCollectionUnrestricted !== true
    || approval.priorOutlayBasisReviewed !== true || approval.keyLimitUsd !== 69 || approval.allInCeilingUsd !== 75
    || approval.keyId !== policy.keyId || approval.workspaceId !== policy.workspaceId
    || approval.policySha256 !== policyDigest(policy) || !SHA.test(approval.policySha256 || "")
    || !iso(approval.reviewedAt) || !iso(approval.expiresAt)
    || Date.parse(approval.reviewedAt) > now.getTime() || Date.parse(approval.expiresAt) <= now.getTime()
    || Date.parse(approval.expiresAt) > Date.parse(policy.expiresAt)
    || !BALANCE(approval.availableCreditUsd) || !MONEY(approval.keyRemainingUsd)
    || approval.availableCreditUsd <= 0 || approval.keyRemainingUsd <= 0 || approval.keyRemainingUsd > 69) {
    return "owner/security account and exact cohort approval missing, expired or changed";
  }
  return null;
}

function readProtected(file, label) {
  // Open without following links, then check the SAME descriptor we read, so a
  // swap between a path check and the read cannot expose a different file.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
      || stat.size > 1024 * 1024 || stat.nlink !== 1) {
      throw new Error(`${label} must be owner-owned mode 600 and unlinked`);
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}

export class JevCohortStore {
  constructor({ configPath, approvalPath, ledgerPath, home = null }) {
    // The store is the dispatcher's config dir (MOVIECAL_CONFIG_DIR aware), or
    // exactly `<home>/.config/moviecal` when a home is pinned. All three files
    // must share it, so none can live in a repository or worktree.
    const root = home ? path.join(home, ".config", "moviecal") : path.dirname(configPath || "");
    for (const file of [configPath, approvalPath, ledgerPath]) {
      if (!file || !path.isAbsolute(file) || path.dirname(file) !== root) throw new Error("cohort files must be in the dedicated external store");
    }
    this.configPath = configPath;
    this.approvalPath = approvalPath;
    this.ledger = new JsonStateStore(ledgerPath);
  }

  updateLedger(mutator) {
    const lock = `${this.ledger.statePath}.lock`;
    const deadline = Date.now() + 2000;
    while (true) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== "EEXIST" || Date.now() >= deadline) throw new Error("cohort ledger lock unavailable");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try { return this.ledger.update(mutator); }
    finally { fs.rmdirSync(lock); }
  }

  policy(now = new Date()) {
    if (!fs.existsSync(this.configPath)) return null;
    const config = readProtected(this.configPath, "cohort config");
    if (config.enabled !== true) return null;
    const approval = readProtected(this.approvalPath, "cohort approval");
    const error = validateCohortApproval(config.policy, approval, now);
    if (error) throw new Error(error);
    return config.policy;
  }

  activate(now = new Date()) {
    const config = readProtected(this.configPath, "cohort config");
    const approval = readProtected(this.approvalPath, "cohort approval");
    const error = validateCohortApproval(config.policy, approval, now);
    if (error) throw new Error(error);
    if (Date.parse(config.policy.activatedAt) > now.getTime()) throw new Error("activation time is in the future");
    if (this.ledger.load().stoppedReason || Object.keys(this.ledger.load().assignments || {}).length)
      throw new Error("cohort ledger already contains assignments or a stop; use a newly reviewed cohort");
    new JsonStateStore(this.configPath).save({ enabled: true, policy: config.policy });
    return this.state(now);
  }

  get(issue) {
    return this.ledger.load().assignments?.[issue] || null;
  }

  state(now = new Date()) {
    let config, approval, ledger;
    try {
      if (!fs.existsSync(this.configPath)) return { status: "disabled" };
      config = readProtected(this.configPath, "cohort config");
      ledger = this.ledger.load();
      if (config.enabled !== true) return { status: "disabled", stoppedAt: config.stoppedAt || null };
      approval = readProtected(this.approvalPath, "cohort approval");
      const error = validateCohortApproval(config.policy, approval, now);
      if (error) return { status: "invalid", error };
    } catch (error) { return { status: "invalid", error: error.message }; }
    const policy = config.policy;
    if ((ledger.requests && (typeof ledger.requests !== "object" || Array.isArray(ledger.requests)))
      || (ledger.assignments && (typeof ledger.assignments !== "object" || Array.isArray(ledger.assignments)))
      || (ledger.fees && !Array.isArray(ledger.fees))
      || (ledger.observedKeyUsageUsd !== undefined && !MONEY(ledger.observedKeyUsageUsd))
      || (ledger.keyRemainingUsd !== undefined && (!MONEY(ledger.keyRemainingUsd) || ledger.keyRemainingUsd > 69))
      || ((ledger.observedKeyUsageUsd ?? policy.baselineKeyUsageUsd) + (ledger.keyRemainingUsd ?? approval.keyRemainingUsd) > 69 + 1e-6))
      return { status: "invalid", error: "cohort ledger shape or account evidence invalid" };
    const rows = Object.values(ledger.requests || {});
    const fees = ledger.fees || [];
    const assignments = Object.entries(ledger.assignments || {});
    if (assignments.some(([id, r]) => !ISSUE.test(id) || r?.issue !== id
      || !["routed", "control"].includes(r.side)
      || !policy.pairs.some((pair) => pair[r.side] === id)
      || r.policyHash !== policyDigest(policy) || r.worker !== "codex"
      || r.tier !== policy.control.tier
      || (r.side === "control" && r.effort !== policy.control.effort)))
      return { status: "invalid", error: "cohort assignment evidence invalid" };
    if (rows.some((r) => !r || !ID.test(r.requestId || "") || !ISSUE.test(r.issue || "")
      || !ledger.assignments?.[r.issue]
      || !["pending", "complete"].includes(r.status) || !MONEY(r.reservedUsd)
      || (r.status === "complete" && (!MONEY(r.amountUsd) || !ID.test(r.invoiceId || "")
        || !ID.test(r.model || "") || !ID.test(r.provider || "") || !["low", "medium", "high", "xhigh", "max"].includes(r.effort))))
      || fees.some((f) => !ID.test(f?.id || "") || !MONEY(f?.amountUsd) || !ID.test(f?.description || ""))
      || new Set(rows.filter((r) => r.status === "complete").map((r) => r.invoiceId)).size !== rows.filter((r) => r.status === "complete").length
      || new Set(fees.map((f) => f.id)).size !== fees.length)
      return { status: "invalid", error: "cohort invoice or fee evidence invalid" };
    const invoiced = rows.filter((r) => r.status === "complete").reduce((n, r) => n + r.amountUsd, 0);
    const observed = Math.max(0, (ledger.observedKeyUsageUsd ?? policy.baselineKeyUsageUsd) - policy.baselineKeyUsageUsd);
    const spent = round(policy.priorOutlayUsd + policy.purchaseFeesUsd + fees.reduce((n, f) => n + f.amountUsd, 0) + Math.max(invoiced, observed));
    const routed = Object.values(ledger.assignments || {}).filter((r) => r.side === "routed").length;
    const control = Object.values(ledger.assignments || {}).filter((r) => r.side === "control").length;
    const base = { trialId: policy.trialId, routed, control, spentUsd: spent, remainingUsd: round(Math.max(0, 75 - spent)),
      keyRemainingUsd: ledger.keyRemainingUsd ?? approval.keyRemainingUsd,
      pending: rows.filter((r) => r.status === "pending").length, expiresAt: policy.expiresAt,
      policySha256: policyDigest(policy), stoppedReason: ledger.stoppedReason || null };
    if (ledger.stoppedReason) return { ...base, status: "stopped" };
    if (now.getTime() < Date.parse(policy.activatedAt)) return { ...base, status: "invalid", error: "activation time is in the future" };
    if (now.getTime() >= Date.parse(policy.expiresAt)) return { ...base, status: "expired" };
    if (spent >= 75 || base.keyRemainingUsd <= 0) return { ...base, status: "spend-exhausted" };
    if (base.pending) return { ...base, status: "pending-invoice" };
    return { ...base, status: "active" };
  }

  side(issue) {
    const config = readProtected(this.configPath, "cohort config");
    const pair = config.policy?.pairs?.find((p) => p.routed === issue || p.control === issue);
    return pair ? (pair.routed === issue ? "routed" : "control") : null;
  }

  preview(issue, { worker, tier, effort, now = new Date() }) {
    const existing = this.get(issue.identifier);
    const side = existing?.side || this.side(issue.identifier);
    if (!side) return { admitted: false, side: null, reason: "outside preselected cohort" };
    const state = this.state(now);
    if (state.status !== "active") return { admitted: false, side, existing: Boolean(existing), reason: `cohort ${state.status}` };
    const policy = this.policy(now);
    const labels = new Set((issue.labels || []).map((v) => String(v).toLowerCase()));
    if ([...labels].some((label) => EXCLUDED_LABELS.has(label)) || (side === "routed" && !labels.has("router:jev")))
      return { admitted: false, side, reason: "issue label is ineligible" };
    if (worker !== "codex" || tier !== policy.control.tier
      || (side === "control" && effort !== policy.control.effort))
      return { admitted: false, side, reason: "worker/model/effort pin mismatch" };
    if (!existing && (side === "routed" ? state.routed : state.control) >= 12)
      return { admitted: false, side, reason: "side assignment cap" };
    return { admitted: true, side, existing: Boolean(existing), reason: null };
  }

  admit(issue, { worker, tier, effort, now = new Date() }) {
    const existing = this.get(issue.identifier);
    if (existing) {
      const decision = this.preview(issue, { worker, tier, effort, now });
      return decision.admitted
        ? { admitted: true, record: existing, existing: true }
        : { admitted: false, record: existing, existing: true, reason: decision.reason };
    }
    const decision = this.preview(issue, { worker, tier, effort, now });
    if (!decision.admitted) return { admitted: false, reason: decision.reason };
    const { side } = decision;
    const policy = this.policy(now);
    const record = { issue: issue.identifier, trialId: policy.trialId, side,
      armId: side === "routed" ? "jev-hosted" : "fixed-control", policyHash: policyDigest(policy),
      worker, tier, effort, assignedAt: now.toISOString() };
    this.updateLedger((data) => {
      if (data.stoppedReason || this.state(now).status !== "active") throw new Error("cohort changed during admission");
      data.assignments ||= {};
      if (!data.assignments[issue.identifier]) data.assignments[issue.identifier] = record;
    });
    return { admitted: true, record, existing: false };
  }

  stop(reason = "operator-stop", now = new Date()) {
    this.updateLedger((data) => { data.stoppedReason ||= reason; data.stoppedAt ||= now.toISOString(); });
    if (fs.existsSync(this.configPath)) {
      const config = readProtected(this.configPath, "cohort config");
      new JsonStateStore(this.configPath).save({ ...config, enabled: false, stoppedAt: now.toISOString() });
    }
    return this.state(now);
  }

  export() {
    const data = this.ledger.load();
    return { state: this.state(), assignments: Object.values(data.assignments || {}),
      requests: Object.values(data.requests || {}), fees: data.fees || [],
      observedKeyUsageUsd: data.observedKeyUsageUsd ?? null,
      keyRemainingUsd: data.keyRemainingUsd ?? null, stoppedReason: data.stoppedReason || null };
  }

  recordFee({ id, amountUsd, description = "fee" }) {
    if (!ID.test(id || "") || !MONEY(amountUsd) || !ID.test(description)) throw new Error("invalid fee evidence");
    this.updateLedger((data) => {
      data.fees ||= [];
      const existing = data.fees.find((f) => f.id === id);
      if (existing && (existing.amountUsd !== amountUsd || existing.description !== description)) throw new Error("fee identity changed");
      if (!existing) data.fees.push({ id, amountUsd, description });
    });
    return this.state();
  }

  // Reserve the *entire remaining key allowance*, not a guessed token price.
  // One unresolved request or crash blocks all later paid requests. The key's
  // independently enforced $69 TOTAL cap bounds that request's maximum cash
  // exposure; an invoice releases the reservation after durable accounting.
  reserve(requestId, issue, account, now = new Date()) {
    if (!ID.test(requestId) || !ISSUE.test(issue)) throw new Error("invalid request identity");
    const state = this.state(now);
    if (state.status !== "active" || !this.get(issue)) throw new Error(`cohort request stopped: ${state.status}`);
    if (!MONEY(account.keyUsageUsd) || !MONEY(account.keyRemainingUsd) || !BALANCE(account.availableCreditUsd)
      || account.keyRemainingUsd <= 0 || account.availableCreditUsd <= 0
      || account.keyUsageUsd < this.policy(now).baselineKeyUsageUsd
      || account.keyRemainingUsd > 69 - account.keyUsageUsd
      || account.keyRemainingUsd > state.remainingUsd || account.keyRemainingUsd > account.availableCreditUsd) {
      this.stop("unknown-or-excess-account-exposure", now);
      throw new Error("unknown or excessive account exposure");
    }
    this.updateLedger((data) => {
      if (data.stoppedReason || Object.values(data.requests || {}).some((r) => r.status === "pending"))
        throw new Error("cohort stopped or another request is unresolved");
      const fresh = this.state(now);
      if (fresh.status !== "active" || account.keyRemainingUsd > fresh.remainingUsd)
        throw new Error("cohort budget changed during request reservation");
      data.requests ||= {};
      if (data.requests[requestId]) throw new Error("duplicate paid request identity");
      data.requests[requestId] = { requestId, issue, status: "pending", reservedUsd: account.keyRemainingUsd, startedAt: now.toISOString() };
      data.observedKeyUsageUsd = Math.max(data.observedKeyUsageUsd || 0, account.keyUsageUsd);
      data.keyRemainingUsd = account.keyRemainingUsd;
    });
  }

  finish(requestId, { invoiceId, amountUsd, model, provider, effort, account }, now = new Date()) {
    if (!ID.test(invoiceId || "") || !MONEY(amountUsd) || !ID.test(model || "") || !ID.test(provider || "")
      || !["low", "medium", "high", "xhigh", "max"].includes(effort)
      || !MONEY(account?.keyUsageUsd) || !MONEY(account?.keyRemainingUsd)) {
      this.stop("missing-request-invoice-or-model", now);
      throw new Error("missing request invoice or served identity");
    }
    this.updateLedger((data) => {
      const row = data.requests?.[requestId];
      if (row?.status === "complete" && row.invoiceId === invoiceId && row.amountUsd === amountUsd
        && row.model === model && row.provider === provider && row.effort === effort) return;
      if (!row || row.status !== "pending") throw new Error("request reservation missing");
      if (amountUsd > row.reservedUsd) throw new Error("invoice exceeds reserved key allowance");
      if (Object.values(data.requests).some((r) => r.invoiceId === invoiceId)) throw new Error("duplicate provider invoice");
      Object.assign(row, { status: "complete", invoiceId, amountUsd, model, provider, effort, completedAt: now.toISOString() });
      data.observedKeyUsageUsd = Math.max(data.observedKeyUsageUsd || 0, account.keyUsageUsd);
      data.keyRemainingUsd = account.keyRemainingUsd;
    });
    if (this.state(now).spentUsd > 75) this.stop("all-in-ceiling", now);
  }
}

export function resolveCohortTransport(store, assignment, { home = os.homedir(), preview = false } = {}) {
  const policy = store.policy();
  const selected = policy?.pairs?.some((pair) => pair[assignment?.side] === assignment?.issue);
  if (!policy || !assignment || assignment.policyHash !== policyDigest(policy)
    || !selected || (!preview && store.get(assignment.issue)?.policyHash !== assignment.policyHash)) throw new Error("cohort assignment or approval unavailable");
  const side = assignment.side;
  if (!["routed", "control"].includes(side)) throw new Error("unknown cohort side");
  return {
    enabled: true,
    upstream: "https://openrouter.ai/api/v1/responses",
    credentialPath: path.join(home, ".config", "moviecal", "openrouter-jev.env"),
    policy: {
      hash: assignment.policyHash, side,
      model: side === "routed" ? "typesafe/jev-router" : policy.control.model,
      provider: side === "control" ? policy.control.provider : null,
      effort: side === "control" ? policy.control.effort : null,
      providers: [], zdr: false, dataCollection: null, promptLogging: false,
      keyLimitUsd: 69, spendCeilingUsd: 75,
      keyId: policy.keyId, workspaceId: policy.workspaceId, ownerReviewed: true,
    },
    cohort: { configPath: store.configPath, approvalPath: store.approvalPath,
      ledgerPath: store.ledger.statePath, issue: assignment.issue, side, home },
  };
}
