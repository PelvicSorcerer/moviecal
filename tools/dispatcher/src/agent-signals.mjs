// Inbound agent control signals: follow-up prompts and stop requests
// (MOV-168, extracted from MOV-158).
//
// There are two independent sources, and keeping them separate is the point:
//
//   1. **Agent Session webhooks** — Linear delivers `prompted` and `stop` as
//      Agent Session events. This is the low-latency path, and it is *not*
//      available today: MOV-141 found Agent Sessions disabled for the
//      `moviecal-dispatcher` app, and enabling them needs an HTTPS receiver
//      the local Mac must not expose (MOV-159 is that decision gate, MOV-166
//      owns any live enablement). So this module implements payload
//      *handling* — signature verification, normalization, trust, idempotency
//      — and deliberately implements **no listener, no server, and no open
//      port**. Nothing here reads or provisions a secret: `verifyWebhookSignature`
//      is handed one by a future caller and fails closed when there is none,
//      which is exactly what happens today. Fixtures drive it in tests, and
//      `dispatcher agent-signal --fixture <path>` drives it by hand.
//
//   2. **Polling** — re-reading the issue and noticing that a human removed
//      the delegation, moved it out of the states this dispatcher may work
//      under, or canceled it. This needs no entitlement and no inbound
//      connectivity, and it is the stop control that actually works right now
//      (MOV-141: "Removing delegation or canceling/changing the issue remains
//      the polling-based stop control at the dispatcher's safe re-read
//      boundary").
//
// Both normalize to the same stop request, and `StopController` is the single
// thing `run-loop.mjs` consults — so the webhook path, if it is ever enabled,
// changes latency and nothing else (acceptance criterion 4).
//
// Pure logic only; every I/O dependency is injected by the caller.

import { createHmac, timingSafeEqual } from "node:crypto";
import { confirmStillClaimable, isLocalDispatcherDelegate, normalizeDelegate } from "./dispatch-eligibility.mjs";

export const AGENT_SESSION_WEBHOOK_TYPE = "AgentSessionEvent";
export const WEBHOOK_SIGNATURE_HEADER = "linear-signature";
/** Linear requires a receiver to answer within five seconds; a delivery older than this is a replay, not a live event. */
export const WEBHOOK_MAX_AGE_MS = 60_000;

/**
 * The workflow states an in-flight attempt may legitimately be in.
 *
 * Both are needed, not just `Agent Working`: the dispatcher moves the issue
 * there itself, and a re-read that races that write can still legitimately
 * observe `Ready for Agent`. Treating that as "incompatible state" would stop
 * healthy work on its own transition.
 */
export const ACTIVE_WORK_STATES = Object.freeze(["Ready for Agent", "Agent Working"]);

/**
 * The named points in an attempt at which a pending stop is honoured. A stop
 * observed anywhere takes effect at the *next* one of these, never mid-edit —
 * that is what "safe interruption boundary" means here.
 */
export const INTERRUPTION_BOUNDARIES = Object.freeze([
  // before the worktree exists; losing here is a total no-op
  "before-claim",
  // while the worker runs; honoured by aborting its process group
  "during-worker",
  // worker has exited and nothing has been reported yet
  "after-worker",
  // before the dispatcher applies a staged workflow-edit proposal (MOV-121)
  "before-workflow-edit",
  // before the PR link and `In Review` transition are written
  "before-pr-report",
]);

function text(value) {
  return String(value ?? "").trim();
}

/**
 * Constant-time HMAC-SHA256 check of a raw webhook body.
 *
 * `rawBody` must be the exact bytes received — re-serializing parsed JSON
 * changes key order and whitespace and will not verify. Returns a reason
 * rather than throwing so a caller can log one line and drop the delivery.
 */
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!signature) return { ok: false, reason: "delivery carried no signature header" };
  if (rawBody == null) return { ok: false, reason: "delivery carried no body" };
  const expected = createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");
  const provided = text(signature).toLowerCase();
  if (provided.length !== expected.length) return { ok: false, reason: "signature length mismatch" };
  const equal = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
  return equal ? { ok: true, reason: null } : { ok: false, reason: "signature did not match" };
}

function promptBody(activity) {
  if (!activity || typeof activity !== "object") return "";
  const content = activity.content && typeof activity.content === "object" ? activity.content : {};
  return text(content.body || content.prompt || activity.body);
}

function normalizeActor(node) {
  if (!node || typeof node !== "object") return null;
  const id = text(node.id) || null;
  const name = text(node.name || node.displayName) || null;
  const type = text(node.type || (node.__typename === "User" ? "user" : "")).toLowerCase() || null;
  if (!id && !name) return null;
  return { id, name, type };
}

/**
 * Turn one Agent Session webhook delivery into a normalized signal, or explain
 * why it is not usable. Never throws on a malformed payload — a hostile or
 * simply wrong delivery must produce a rejection, not an exception in the
 * dispatch loop.
 *
 * Recognized kinds:
 *   - `created`  — Linear created a session for us; acknowledge promptly
 *   - `prompted` — a follow-up prompt (trust is decided separately)
 *   - `stop`     — forbids any further agent action; carried either as its own
 *                  action or as a `stop` signal on a prompted activity
 *
 * @returns {{ok: boolean, kind: string|null, reason: string|null, key: string|null, sessionId: string|null, issueId: string|null, issueIdentifier: string|null, prompt: string, actor: object|null, receivedAt: string|null}}
 */
export function normalizeAgentSessionEvent(payload, { now = Date.now(), maxAgeMs = WEBHOOK_MAX_AGE_MS } = {}) {
  const reject = (reason) => ({
    ok: false,
    kind: null,
    reason,
    key: null,
    sessionId: null,
    issueId: null,
    issueIdentifier: null,
    prompt: "",
    actor: null,
    receivedAt: null,
  });

  if (!payload || typeof payload !== "object") return reject("payload is not an object");
  if (text(payload.type) !== AGENT_SESSION_WEBHOOK_TYPE) {
    return reject(`unsupported webhook type: ${text(payload.type) || "(missing)"}`);
  }

  const session = payload.agentSession && typeof payload.agentSession === "object" ? payload.agentSession : null;
  const activity = payload.agentActivity && typeof payload.agentActivity === "object" ? payload.agentActivity : null;
  const sessionId = text(session && session.id) || null;
  if (!sessionId) return reject("delivery names no agent session");

  const action = text(payload.action).toLowerCase();
  const signal = text(activity && (activity.signal || (activity.content && activity.content.signal))).toLowerCase();
  let kind = null;
  if (signal === "stop" || action === "stop" || action === "stopped") kind = "stop";
  else if (action === "created") kind = "created";
  else if (action === "prompted" || action === "prompt") kind = "prompted";
  if (!kind) return reject(`unsupported agent session action: ${action || "(missing)"}`);

  // Timestamp checks are only meaningful when the payload carries one; an
  // undated delivery is accepted and left to the idempotency ledger, since
  // rejecting it would be a guess about Linear's payload shape rather than a
  // real freshness signal.
  const stampedAt = payload.webhookTimestamp
    ? Number(payload.webhookTimestamp)
    : payload.createdAt
      ? new Date(payload.createdAt).getTime()
      : NaN;
  if (Number.isFinite(stampedAt) && now - stampedAt > maxAgeMs) {
    return reject(
      `delivery is ${Math.round((now - stampedAt) / 1000)}s old, past the ${Math.round(maxAgeMs / 1000)}s freshness window`,
    );
  }

  const issue = (session && session.issue) || payload.issue || null;

  return {
    ok: true,
    kind,
    reason: null,
    // Prefer the activity id: Linear retries a delivery with the same
    // webhookId, and two distinct prompts must never collapse onto one key.
    key: `agent-signal:${kind}:${text(activity && activity.id) || sessionId}:${text(payload.webhookId) || (Number.isFinite(stampedAt) ? String(stampedAt) : "")}`,
    sessionId,
    issueId: text(issue && issue.id) || null,
    issueIdentifier: text(issue && issue.identifier) || null,
    prompt: promptBody(activity),
    actor: normalizeActor(payload.actor || (activity && activity.actor) || payload.createdBy || null),
    receivedAt: Number.isFinite(stampedAt) ? new Date(stampedAt).toISOString() : null,
  };
}

/**
 * At-most-once processing for inbound signals.
 *
 * Linear retries a delivery it did not get a timely response to, so the same
 * prompt can arrive several times. Bounded and serializable so it can live
 * alongside the rest of the dispatcher's durable state.
 */
export class SignalLedger {
  constructor({ seen = [], max = 500 } = {}) {
    this.max = Math.max(1, Number(max) || 500);
    this.seen = new Set(seen.filter(Boolean).slice(-this.max));
  }

  has(key) {
    return Boolean(key) && this.seen.has(key);
  }

  /** Record `key`; returns false if it had already been recorded. */
  record(key) {
    if (!key) return false;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    while (this.seen.size > this.max) {
      const oldest = this.seen.values().next().value;
      this.seen.delete(oldest);
    }
    return true;
  }

  toJSON() {
    return [...this.seen];
  }
}

/**
 * May a follow-up prompt steer this attempt?
 *
 * Default policy is deliberately narrow: a prompt is trusted only when it
 * comes from a real workspace user, and never when it comes from this
 * dispatcher's own actor — an agent that acts on its own emitted activity is
 * a feedback loop, not a follow-up. `trustedActorIds`/`trustedActorNames`,
 * when configured, narrow it further to an explicit allowlist.
 *
 * A stop signal is intentionally **not** routed through this: refusing to stop
 * because the requester was not on an allowlist is the wrong failure mode.
 * Stops are always honoured; only *instructions* need trust.
 */
export function classifyPromptTrust(
  signal,
  { trustedActorIds = [], trustedActorNames = [], selfActorIds = [], selfActorNames = [] } = {},
) {
  if (!signal || !signal.ok) return { trusted: false, reason: "signal was not usable" };
  if (signal.kind !== "prompted") {
    return { trusted: false, reason: `only follow-up prompts can steer an attempt (got "${signal.kind}")` };
  }
  if (!text(signal.prompt)) return { trusted: false, reason: "prompt carried no body" };
  const actor = signal.actor;
  if (!actor) return { trusted: false, reason: "prompt names no actor" };

  const ids = new Set(selfActorIds.filter(Boolean).map((v) => text(v)));
  const names = new Set(selfActorNames.filter(Boolean).map((v) => text(v).toLowerCase()));
  if ((actor.id && ids.has(actor.id)) || (actor.name && names.has(actor.name.toLowerCase()))) {
    return { trusted: false, reason: "prompt originated from this dispatcher's own actor" };
  }

  if (trustedActorIds.length || trustedActorNames.length) {
    const allowedIds = new Set(trustedActorIds.filter(Boolean).map((v) => text(v)));
    const allowedNames = new Set(trustedActorNames.filter(Boolean).map((v) => text(v).toLowerCase()));
    const allowed = (actor.id && allowedIds.has(actor.id)) || (actor.name && allowedNames.has(actor.name.toLowerCase()));
    if (!allowed) return { trusted: false, reason: `actor ${actor.name || actor.id} is not on the trusted-prompt allowlist` };
    return { trusted: true, reason: null };
  }

  if (actor.type && actor.type !== "user") {
    return { trusted: false, reason: `prompts from a ${actor.type} actor are not trusted without an explicit allowlist` };
  }
  return { trusted: true, reason: null };
}

/**
 * Build a stop request from an inbound `stop` signal.
 * `mayWrite` is true: an explicit stop came through the session, so this
 * dispatcher is still that issue's writer and may record why it stopped.
 */
export function stopRequestFromSignal(signal) {
  if (!signal || !signal.ok || signal.kind !== "stop") return null;
  return {
    source: "agent-session",
    reason: "a stop signal was received on the Agent Session",
    detail: text(signal.prompt) || null,
    sessionId: signal.sessionId,
    mayWrite: true,
  };
}

/**
 * The single entry point for an inbound Agent Session delivery, so the webhook
 * path and the polling path converge on one `StopController` (acceptance
 * criterion 4) and a replayed delivery is a no-op.
 *
 * Verification is the caller's: a future receiver checks the signature against
 * the raw bytes before handing the parsed payload here. There is no receiver
 * today, and this function neither opens nor implies one.
 *
 * @param {object} payload - a parsed Agent Session webhook body
 * @param {object} opts
 * @param {StopController} opts.controller
 * @param {SignalLedger} [opts.ledger]
 * @param {object} [opts.trust] - options for classifyPromptTrust
 * @param {number} [opts.now]
 * @returns {{handled: boolean, kind: string|null, reason: string|null, replay: boolean, stopped: boolean, prompt: {trusted: boolean, reason: string|null, body: string}|null}}
 */
export function handleAgentSignal(payload, { controller, ledger = new SignalLedger(), trust = {}, now = Date.now() } = {}) {
  const signal = normalizeAgentSessionEvent(payload, { now });
  if (!signal.ok) {
    return { handled: false, kind: null, reason: signal.reason, replay: false, stopped: false, prompt: null };
  }
  if (ledger.has(signal.key)) {
    // A retried delivery. Deliberately reports the *current* stop state rather
    // than "nothing happened": a replayed stop must still read as stopped.
    return {
      handled: false,
      kind: signal.kind,
      reason: "delivery was already processed",
      replay: true,
      stopped: Boolean(controller && controller.stopped),
      prompt: null,
    };
  }
  ledger.record(signal.key);

  if (signal.kind === "stop") {
    const request = stopRequestFromSignal(signal);
    if (controller) controller.request(request);
    return { handled: true, kind: "stop", reason: null, replay: false, stopped: true, prompt: null };
  }
  if (signal.kind === "prompted") {
    const verdict = classifyPromptTrust(signal, trust);
    return {
      handled: verdict.trusted,
      kind: "prompted",
      reason: verdict.reason,
      replay: false,
      stopped: Boolean(controller && controller.stopped),
      prompt: { trusted: verdict.trusted, reason: verdict.reason, body: signal.prompt },
    };
  }
  return {
    handled: true,
    kind: signal.kind,
    reason: null,
    replay: false,
    stopped: Boolean(controller && controller.stopped),
    prompt: null,
  };
}

/**
 * The stop control that works today, with no entitlement and no inbound
 * connectivity: re-read the issue and notice that it is no longer this
 * dispatcher's to act on.
 *
 * `mayWrite` matters. If the issue is still delegated here, the dispatcher is
 * still its writer and should record why it stopped. If the delegation was
 * removed, it is not — and commenting anyway would be exactly the boundary
 * violation `dispatch-eligibility.mjs` exists to prevent. So a de-delegated
 * issue stops **silently**.
 *
 * A `null` return means "keep going". Callers must not translate a *failed*
 * re-read into a stop: a transient Linear error is not a human asking to halt,
 * and treating it as one would kill healthy work on a network blip. A re-read
 * that succeeds and returns `null` is different — the issue is genuinely gone
 * or no longer visible — and does stop, silently.
 *
 * @param {object|null} fresh - snapshot from LinearClient.issueSnapshot()
 * @param {{expectedDelegate?: object, allowedStates?: string[]}} [opts]
 * @returns {{source: string, reason: string, detail: string|null, mayWrite: boolean}|null}
 */
export function detectStopFromSnapshot(fresh, { expectedDelegate = {}, allowedStates = ACTIVE_WORK_STATES } = {}) {
  if (!fresh) {
    return {
      source: "polling",
      reason: "issue is no longer readable from Linear",
      detail: null,
      mayWrite: false,
    };
  }
  const stillDelegatedHere = isLocalDispatcherDelegate(normalizeDelegate(fresh.delegate), expectedDelegate);

  // The state check is its own step rather than `confirmStillClaimable`'s
  // single `expectedState`, because an in-flight attempt is legitimately in
  // either of two states (see ACTIVE_WORK_STATES) — and because a human moving
  // the issue to `Canceled`, `Needs Human Decision`, or anywhere else is the
  // cancellation signal this whole function exists to catch.
  const stateName = fresh.stateName ? String(fresh.stateName) : null;
  if (stateName && Array.isArray(allowedStates) && allowedStates.length && !allowedStates.includes(stateName)) {
    return {
      source: "polling",
      reason: `issue moved to "${stateName}", which this dispatcher does not work under`,
      detail: `expected one of: ${allowedStates.join(", ")}`,
      mayWrite: stillDelegatedHere,
    };
  }

  const claim = confirmStillClaimable(fresh, { expectedDelegate, expectedState: null });
  if (claim.claimable) return null;
  return {
    source: "polling",
    reason: claim.reason,
    detail: stateName ? `issue state is now "${stateName}"` : null,
    mayWrite: stillDelegatedHere,
  };
}

/**
 * Records that a stop was requested and answers, at each named boundary,
 * whether the attempt must halt.
 *
 * Only the *first* request is kept. A stop is not a counter, and re-requesting
 * must not restate the reason or re-fire `onStop`; that is what makes the
 * whole thing idempotent under a retried webhook delivery or a poll that
 * observes the same removed delegation on every pass.
 */
export class StopController {
  constructor({ onStop = () => {} } = {}) {
    this.onStop = onStop;
    this._request = null;
    this.boundariesChecked = [];
  }

  get stopped() {
    return this._request !== null;
  }

  get stopRequest() {
    return this._request;
  }

  /** Record a stop request. Returns the effective (first) request. */
  request(stopRequest) {
    if (!stopRequest) return this._request;
    if (this._request) return this._request;
    this._request = { mayWrite: true, ...stopRequest };
    try {
      this.onStop(this._request);
    } catch {
      // A stop must be recorded even if a listener throws.
    }
    return this._request;
  }

  /**
   * Consult the controller at a named boundary.
   * @returns {{halt: boolean, boundary: string, request: object|null}}
   */
  checkpoint(boundary) {
    if (!INTERRUPTION_BOUNDARIES.includes(boundary)) {
      throw new Error(`unknown interruption boundary: ${boundary}`);
    }
    this.boundariesChecked.push(boundary);
    return { halt: this.stopped, boundary, request: this._request };
  }
}

/** Sleep that resolves early when `signal` aborts, so a settled worker leaves no dangling timer. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll for a stop while a worker runs, so a human's stop request is honoured
 * within one interval instead of only after a 45-minute worker finishes.
 *
 * Fails **open**: an `observeStopFn` that throws is retried on the next tick
 * and never interpreted as a stop.
 *
 * @param {object} opts
 * @param {StopController} opts.controller
 * @param {() => Promise<object|null>} opts.observeStopFn - resolves to a stop request, or null
 * @param {number} opts.intervalMs - 0 disables the watcher entirely
 * @param {AbortSignal} [opts.signal] - abort to stop watching (the worker settled)
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleepFn]
 * @returns {Promise<object|null>} the stop request that was observed, or null
 */
export async function watchForStop({ controller, observeStopFn, intervalMs = 0, signal, sleepFn = abortableSleep } = {}) {
  if (typeof observeStopFn !== "function" || !(intervalMs > 0) || !controller) return null;
  while (!controller.stopped && !(signal && signal.aborted)) {
    await sleepFn(intervalMs, signal);
    if (signal && signal.aborted) break;
    if (controller.stopped) break;
    let observed = null;
    try {
      observed = await observeStopFn();
    } catch {
      continue;
    }
    if (observed) return controller.request(observed);
  }
  return controller.stopRequest;
}
