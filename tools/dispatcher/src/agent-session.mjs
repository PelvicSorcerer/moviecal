// Lifecycle serialization and the feature-gated Linear Agent Session bridge
// (MOV-167, extracted from MOV-158).
//
// ## What this is, and what it deliberately is not
//
// Linear's Agent Session API (Developer Preview) gives an agent a first-class
// surface on an issue: a session under the agent's own identity, semantic
// *activities* (thought / action / elicitation / response / error) instead of
// prose comments, an external URL slot for the PR, and inbound follow-up
// prompts and `stop` signals.
//
// `MOV-141` established the live entitlement state, and it is the reason this
// module is shaped the way it is (see
// docs/governance/mov-141-linear-capability-findings.md):
//
//   - `agentSessionCreateOnIssue` returned **`agent sessions disabled`** for
//     the `moviecal-dispatcher` app. Sessions are not usable today.
//   - Enabling them requires the OAuth app to subscribe to Agent Session
//     events and expose a **reachable HTTPS receiver**. The local Mac must not
//     expose an inbound listener; `MOV-159` is the decision gate for whether a
//     signed relay is worth its attack surface, and `MOV-166` owns any later
//     live enablement.
//
// So this module implements the whole dispatcher-side contract and gates it
// behind capability detection: **sessions are an enrichment layer, never a
// dependency.** When they are off (today's reality, and the default), every
// call here is a cheap no-op and the dispatcher's existing app-actor comments
// and workflow-state transitions remain the complete, sufficient surface.
//
// ## One event, two renderings
//
// A dispatcher lifecycle event is described **once** — as a plain object with
// a `kind`, a plain-text `summary`, and optional markdown `sections` — and
// `renderLifecycleEvent()` turns that single description into both surfaces:
// the Agent Activity content Linear wants, and the human-readable app-actor
// comment that is published when it does not. Nothing in the dispatcher writes
// the same transition twice in two voices; `agent-lifecycle.mjs` picks exactly
// one surface per event.
//
// ## Unverified against a live session
//
// The mutation documents in `linear-client.mjs` and the content shapes below
// come from Linear's published Developer Preview documentation, not from a
// successful live call — no session could be created to verify them, and
// creating one is a mutation `doctor` must never make. They are therefore
// concentrated in one place, every failure is non-fatal, and the PR link is
// published *both* as an activity body and via the external-link mutation, so
// a wrong field name on one path degrades rather than loses the link.
//
// Pure serialization (`renderLifecycleEvent`, `resolveSessionForAttempt`) is
// separated from all I/O (`AgentSessionBridge`) so the parts worth getting
// right are unit-testable with plain objects — same shape as ci-outcomes.mjs.

import { createHash } from "node:crypto";

/**
 * Linear marks a session with no activity for 30 minutes as **stale**; a later
 * activity can recover it. Past that, and for any session that already reached
 * a terminal status, this dispatcher opens a *new* linked session rather than
 * pretending one process or one session lives forever.
 */
export const STALE_SESSION_MS = 30 * 60 * 1000;

/** Cap on queued-for-retry activities per attempt, so a long Linear outage cannot grow the registry entry without bound. */
export const MAX_PENDING_ACTIVITIES = 50;

/**
 * Every semantic transition the dispatcher publishes. This list is the
 * contract: `run-loop.mjs` may only publish these, and each maps to exactly
 * one Linear activity content type below.
 */
export const AGENT_EVENT_KINDS = Object.freeze([
  "acknowledged",
  "plan",
  "progress",
  "pr-opened",
  "waiting-input",
  "error",
  "repair",
  "stopped",
  "complete",
]);

/**
 * Session statuses Linear derives from the activity that was just emitted.
 * Tracked locally for our own bookkeeping (staleness, "can this be resumed")
 * and for the fallback comment text — the dispatcher never sets status with a
 * separate mutation, because emitting the activity is what sets it.
 */
export const SESSION_STATUS = Object.freeze({
  active: "active",
  awaitingInput: "awaitingInput",
  error: "error",
  complete: "complete",
});

const TERMINAL_STATUSES = new Set([SESSION_STATUS.error, SESSION_STATUS.complete, "canceled", "cancelled"]);

function text(value) {
  return String(value ?? "").trim();
}

function shortHash(value) {
  return createHash("sha256").update(text(value)).digest("hex").slice(0, 12);
}

/**
 * Does this error mean the workspace/app simply is not entitled to Agent
 * Sessions, as opposed to a transient failure worth retrying?
 *
 * The distinction is the whole difference between "stop trying, comments are
 * the surface" (MOV-141's live finding) and "queue this and retry next poll".
 * Matched on message text because Linear returns it as a plain GraphQL error
 * string, which `LinearClient.request()` re-throws verbatim.
 */
export function isAgentSessionsUnavailableError(error) {
  const message = text(error && error.message).toLowerCase();
  if (!message) return false;
  return (
    /agent sessions?\s+(are\s+)?disabled/.test(message) ||
    /agent sessions?\s+(are\s+)?not\s+(enabled|available|supported)/.test(message) ||
    /agent session.*not\s+entitled/.test(message)
  );
}

/**
 * The durable identity line every activity carries: issue, branch, PR, and —
 * when this attempt runs under a fresh session — the session it continues.
 *
 * This is what makes acceptance criterion 5 hold. A CI repair may legitimately
 * need a *new* Agent Session (the previous one finished and cannot be safely
 * resumed), and a reader must still be able to see at a glance that it is the
 * same work: the durable identity is the issue + branch + PR, never the
 * session id.
 */
export function durableIdentity({ issue = {}, branch = null, prUrl = null, previousSessionId = null, attempt = 1 } = {}) {
  const parts = [];
  if (issue && issue.identifier) parts.push(text(issue.identifier));
  if (branch) parts.push(`branch \`${text(branch)}\``);
  if (prUrl) parts.push(`PR ${text(prUrl)}`);
  if (Number(attempt) > 1) parts.push(`attempt ${Number(attempt)}`);
  if (previousSessionId) parts.push(`continues session ${text(previousSessionId)}`);
  return parts.join(" · ");
}

function normalizeEvent(event = {}) {
  const kind = text(event.kind);
  if (!AGENT_EVENT_KINDS.includes(kind)) {
    throw new Error(`unknown agent event kind: ${kind || "(missing)"}`);
  }
  const summary = text(event.summary);
  if (!summary) throw new Error(`agent event "${kind}" carries no summary`);
  return {
    ...event,
    kind,
    summary,
    detail: text(event.detail),
    // Verbatim, deliberately: sections carry markdown, and both trimming and
    // dropping empty entries corrupt it. Trimming mangles the indentation of a
    // fenced log tail, and an empty entry is a meaningful blank line — the one
    // that separates a closing ``` from the run-log path. Only nullish entries
    // (from a `cond ? x : null` in the caller) are dropped.
    sections: (Array.isArray(event.sections) ? event.sections : [])
      .filter((section) => section !== null && section !== undefined)
      .map((section) => String(section)),
    attempt: Number(event.attempt) > 0 ? Number(event.attempt) : 1,
    issue: event.issue && typeof event.issue === "object" ? event.issue : {},
  };
}

/**
 * The Agent Activity content for one lifecycle event, plus the session status
 * Linear will derive from it and the external URL (if any) to attach.
 *
 * Exported for direct unit testing; `renderLifecycleEvent()` is what callers
 * use, because it produces both surfaces at once.
 */
export function activityFor(rawEvent = {}) {
  const event = normalizeEvent(rawEvent);
  const { kind, summary, detail } = event;
  const identity = durableIdentity(event);
  const body = [summary, detail || null, identity || null].filter(Boolean).join("\n\n");

  switch (kind) {
    case "acknowledged":
      // Linear expects a first activity within ten seconds of session
      // creation, so this is deliberately the cheapest possible publish: no
      // git, no gh, no worker — just "seen, and here is where it will run".
      return { content: { type: "thought", body }, sessionStatus: SESSION_STATUS.active, externalUrl: null };

    case "plan":
    case "repair":
      return { content: { type: "thought", body }, sessionStatus: SESSION_STATUS.active, externalUrl: null };

    case "progress":
      return {
        content: {
          type: "action",
          action: text(event.action) || "progress",
          parameter: text(event.branch) || text(event.issue.identifier) || "unknown",
          result: body,
        },
        sessionStatus: SESSION_STATUS.active,
        externalUrl: null,
      };

    case "pr-opened":
      // Published on two independent paths on purpose: the activity body is
      // guaranteed to render, while `externalUrl` drives Linear's own PR-link
      // affordance on the session. If the external-link mutation's shape is
      // wrong (it is unverified — see the module header), the link is still
      // visible in the activity.
      return {
        content: {
          type: "action",
          action: text(event.action) || "Opened pull request",
          parameter: text(event.prUrl) || "unknown",
          result: body,
        },
        sessionStatus: SESSION_STATUS.active,
        externalUrl: text(event.prUrl) || null,
      };

    case "waiting-input":
      // `elicitation` is the content type that puts a session into
      // awaitingInput — the state acceptance criterion 2 calls "waiting".
      return { content: { type: "elicitation", body }, sessionStatus: SESSION_STATUS.awaitingInput, externalUrl: null };

    case "error":
      return { content: { type: "error", body }, sessionStatus: SESSION_STATUS.error, externalUrl: null };

    case "stopped":
      // A stop signal ends the session. `response` is terminal, which is
      // exactly right: it records why work stopped and forbids anything after.
      return { content: { type: "response", body }, sessionStatus: SESSION_STATUS.complete, externalUrl: null };

    case "complete":
      return {
        content: { type: "response", body },
        sessionStatus: SESSION_STATUS.complete,
        externalUrl: text(event.prUrl) || null,
      };

    /* c8 ignore next 3 */
    default:
      // Unreachable: normalizeEvent() rejects anything not in AGENT_EVENT_KINDS.
      throw new Error(`unhandled agent event kind: ${kind}`);
  }
}

/**
 * The human-readable app-actor comment for one lifecycle event — the surface
 * that is published when Agent Sessions are unavailable, which is every run
 * today.
 *
 * `headline` exists because several of these strings predate MOV-158 and are
 * read back by other code: `promoter.mjs` parses `**Dispatcher preflight
 * failed:** …`, and operators grep for the others. A caller that needs an
 * exact legacy body passes it as `headline`; otherwise the summary is simply
 * bolded.
 */
export function commentFor(rawEvent = {}) {
  const event = normalizeEvent(rawEvent);
  const first = text(event.headline) || `**${event.summary}**`;
  return event.sections.length ? [first, "", ...event.sections].join("\n") : first;
}

/**
 * Serialize one dispatcher lifecycle event into everything both publication
 * surfaces need, exactly once.
 *
 * `key` is the idempotency key: it covers the issue, the attempt, the kind,
 * and a hash of the rendered content, so republishing the same transition (a
 * retried poll cycle, a flushed queue, a replayed stop payload) is a no-op
 * while a genuinely different `progress` or `error` still gets through.
 *
 * @param {object} event
 * @param {string} event.kind - one of AGENT_EVENT_KINDS
 * @param {string} event.summary - plain-text one-line description (required)
 * @param {string} [event.headline] - markdown override for the comment's first line
 * @param {string[]} [event.sections] - extra markdown blocks for the comment
 * @param {string} [event.detail] - extra plain text for the activity body
 * @param {string} [event.action] - short imperative label for `progress`/`pr-opened`
 * @param {{id?: string, identifier?: string, url?: string}} [event.issue]
 * @param {string} [event.branch]
 * @param {string} [event.prUrl]
 * @param {number} [event.attempt]
 * @param {string} [event.previousSessionId]
 * @returns {{kind: string, key: string, comment: string, content: object, sessionStatus: string, externalUrl: string|null, terminal: boolean}}
 */
export function renderLifecycleEvent(rawEvent = {}) {
  const event = normalizeEvent(rawEvent);
  const { content, sessionStatus, externalUrl } = activityFor(event);
  const comment = commentFor(event);
  const identifier = text(event.issue.identifier) || "unknown-issue";
  return {
    kind: event.kind,
    key: `agent-lifecycle:${identifier}:${event.attempt}:${event.kind}:${shortHash(JSON.stringify(content))}`,
    comment,
    content,
    sessionStatus,
    externalUrl,
    terminal: TERMINAL_STATUSES.has(sessionStatus),
  };
}

/**
 * Decide whether this attempt attaches to an existing Agent Session or opens a
 * fresh, linked one.
 *
 * The rule the issue asks for is "use a new linked attempt/session when a
 * finished session cannot be safely resumed". Concretely:
 *
 * - no prior session                            -> create (attempt 1)
 * - prior session reached a terminal status      -> create, linked (attempt n+1)
 * - a prior recovery activity was rejected       -> create, linked (attempt n+1)
 * - prior session stale but recoverable          -> attach; the next activity is
 *                                                   what recovers it, per Linear's
 *                                                   documented staleness contract
 * - otherwise                                    -> attach
 *
 * `recoveryFailed` is checked **independently of staleness**, not as a
 * refinement of it. Gating it behind a fresh staleness computation was wrong:
 * attaching to a session updates the locally-recorded activity time, so by the
 * time the *next* attempt reads the record it no longer looks stale and the
 * rejected-recovery evidence would be silently discarded. A session that
 * refused a recovery activity is unusable whatever the clock says.
 *
 * @param {{id?: string, status?: string, lastActivityAt?: number|string, attempt?: number, recoveryFailed?: boolean, previousSessionId?: string}|null} existing
 * @param {{now?: number, staleAfterMs?: number}} [opts]
 * @returns {{action: "attach"|"create", reason: string, attempt: number, previousSessionId: string|null, stale: boolean}}
 */
export function resolveSessionForAttempt(existing, { now = Date.now(), staleAfterMs = STALE_SESSION_MS } = {}) {
  const priorAttempt = Number(existing && existing.attempt) > 0 ? Number(existing.attempt) : 0;

  if (!existing || !text(existing.id)) {
    return {
      action: "create",
      reason: "no prior session recorded for this issue",
      attempt: Math.max(1, priorAttempt + 1),
      previousSessionId: null,
      stale: false,
    };
  }

  const status = text(existing.status).toLowerCase();
  if (TERMINAL_STATUSES.has(status)) {
    return {
      action: "create",
      reason: `prior session is "${status}" and cannot be safely resumed`,
      attempt: priorAttempt + 1,
      previousSessionId: text(existing.id),
      stale: false,
    };
  }

  const lastActivityAt = existing.lastActivityAt ? new Date(existing.lastActivityAt).getTime() : NaN;
  const stale = Number.isFinite(lastActivityAt) && now - lastActivityAt > staleAfterMs;

  if (existing.recoveryFailed) {
    return {
      action: "create",
      reason: "an earlier recovery activity on the prior session was rejected",
      attempt: priorAttempt + 1,
      previousSessionId: text(existing.id),
      stale,
    };
  }
  return {
    action: "attach",
    reason: stale
      ? "prior session is stale; the next activity should recover it"
      : "prior session is still live",
    attempt: priorAttempt || 1,
    previousSessionId: text(existing.previousSessionId) || null,
    stale,
  };
}

/**
 * Process-wide "we already know the answer" latch for Agent Session
 * entitlement (acceptance criterion 6: never repeatedly attempt an
 * unsupported mutation).
 *
 * `bin/dispatcher.mjs` builds **one** of these and hands the same object to
 * every bridge, so the first `agent sessions disabled` rejection turns the
 * feature off for the life of the process rather than costing one failed
 * mutation per issue per 30-second poll cycle forever.
 */
export function createAgentSessionCapability() {
  return { denied: false, reason: null };
}

/**
 * The dispatcher's handle on one issue's Agent Session for one attempt.
 *
 * Every method is safe to call unconditionally: with sessions off (the default
 * and today's live state), `begin()` reports `disabled` and `publish()` returns
 * without touching the network, so `agent-lifecycle.mjs` needs no conditionals
 * around its lifecycle reporting. Nothing here throws into the dispatch path —
 * an Agent Session problem must never be able to fail an issue whose
 * implementation succeeded.
 */
export class AgentSessionBridge {
  /**
   * @param {object} opts
   * @param {object|null} [opts.linearClient] - LinearClient (or a fake) exposing the agent-session methods
   * @param {boolean} [opts.enabled] - MOVIECAL_AGENT_SESSIONS; false today (MOV-141)
   * @param {{denied: boolean, reason: string|null}} [opts.capability] - shared entitlement latch
   * @param {() => number} [opts.now]
   * @param {{error: Function, log?: Function}} [opts.logger]
   */
  constructor({
    linearClient = null,
    enabled = false,
    capability = createAgentSessionCapability(),
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.linearClient = linearClient;
    this.now = now;
    this.logger = logger;
    this.capability = capability;
    this.enabled = Boolean(enabled);
    this.session = null;
    this.pending = [];
    this.unavailableReason = null;
    if (!this.enabled) {
      this.unavailableReason = "agent sessions are not enabled for this dispatcher (MOVIECAL_AGENT_SESSIONS is unset)";
    } else if (!linearClient || typeof linearClient.createAgentSessionOnIssue !== "function") {
      this.enabled = false;
      this.unavailableReason = "agent sessions are enabled but no Agent-Session-capable Linear client was supplied";
    }
  }

  /** True once Linear has told us this app is not entitled at all. */
  get entitlementDenied() {
    return Boolean(this.capability.denied);
  }

  /** "session" once attached/created, otherwise why not. */
  get mode() {
    if (!this.enabled || this.entitlementDenied) return "disabled";
    if (this.session && this.session.id) return "session";
    return "unavailable";
  }

  /**
   * Create or attach the session for this attempt and record the decision.
   * `existing` is the persisted record from a previous attempt (see
   * `snapshot()`), or null. Never throws.
   */
  async begin(issue, { existing = null } = {}) {
    const decision = resolveSessionForAttempt(existing, { now: this.now() });
    if (!this.enabled) {
      return { mode: "disabled", sessionId: null, reason: this.unavailableReason, decision };
    }
    if (this.entitlementDenied) {
      // MOV-141's live finding, already learned this process. No mutation.
      return { mode: "disabled", sessionId: null, reason: this.capability.reason, decision };
    }
    if (decision.action === "attach") {
      // `lastActivityAt` means "when Linear last accepted an activity", not
      // "when this process last touched the record". Attaching emits nothing,
      // so stamping it to now here would erase the staleness the next attempt
      // has to reason about.
      const priorActivityAt = existing.lastActivityAt ? new Date(existing.lastActivityAt).getTime() : NaN;
      this.session = {
        id: text(existing.id),
        attempt: decision.attempt,
        previousSessionId: decision.previousSessionId,
        status: text(existing.status) || SESSION_STATUS.active,
        lastActivityAt: Number.isFinite(priorActivityAt) ? priorActivityAt : null,
        stale: decision.stale,
        recoveryFailed: Boolean(existing.recoveryFailed),
      };
      return { mode: "session", sessionId: this.session.id, attached: true, reason: decision.reason, decision };
    }
    try {
      const created = await this.linearClient.createAgentSessionOnIssue({ issueId: issue && issue.id });
      const id = text(created && created.id);
      if (!id) throw new Error("agentSessionCreateOnIssue returned no session id");
      this.session = {
        id,
        attempt: decision.attempt,
        previousSessionId: decision.previousSessionId,
        status: SESSION_STATUS.active,
        lastActivityAt: this.now(),
        stale: false,
        recoveryFailed: false,
      };
      return { mode: "session", sessionId: id, attached: false, reason: decision.reason, decision };
    } catch (error) {
      this.session = null;
      this.unavailableReason = error.message;
      if (isAgentSessionsUnavailableError(error)) {
        // The MOV-141 outcome. Not an error to report on the issue: it is the
        // documented current state, and the comment surface already carries
        // everything a human needs. Latched so no later issue retries it.
        this.capability.denied = true;
        this.capability.reason = error.message;
      } else {
        this.logger.error(`Agent Session could not be created for ${issue && issue.id}: ${error.message}`);
      }
      return { mode: "unavailable", sessionId: null, reason: error.message, decision };
    }
  }

  /**
   * Publish one already-serialized activity (from `renderLifecycleEvent()`).
   *
   * Returns `{published: false}` — never throws — whenever the activity did
   * not reach Linear, which is the signal `agent-lifecycle.mjs` uses to fall
   * back to an app-actor comment. A *transient* failure additionally queues the
   * activity for `flushPending()` on a later poll cycle; that queue, not a
   * webhook, is what makes publication eventually consistent.
   */
  async publish(rendered) {
    if (!rendered || !rendered.content) {
      return { published: false, reason: "nothing to publish", key: null };
    }
    if (this.mode !== "session") {
      // Not queued: with no session there is nothing this could ever be
      // delivered to, and the caller's fallback comment is the record.
      return { published: false, reason: this.unavailableReason || "no active session", key: rendered.key };
    }
    try {
      await this.linearClient.createAgentActivity({ agentSessionId: this.session.id, content: rendered.content });
      this.session.lastActivityAt = this.now();
      this.session.status = rendered.sessionStatus;
      this.session.stale = false;
      this.session.recoveryFailed = false;
      if (rendered.externalUrl && typeof this.linearClient.updateAgentSessionExternalLink === "function") {
        try {
          await this.linearClient.updateAgentSessionExternalLink(this.session.id, rendered.externalUrl);
        } catch (error) {
          // Non-fatal by design: the URL is already in the activity body.
          this.logger.error(`Could not set the Agent Session external link: ${error.message}`);
        }
      }
      return { published: true, key: rendered.key };
    } catch (error) {
      if (isAgentSessionsUnavailableError(error)) {
        this.capability.denied = true;
        this.capability.reason = error.message;
        this.unavailableReason = error.message;
        this.session = null;
        return { published: false, reason: error.message, key: rendered.key };
      }
      if (this.session.stale) this.session.recoveryFailed = true;
      if (!this.pending.some((item) => item.key === rendered.key)) {
        this.pending.push(rendered);
        if (this.pending.length > MAX_PENDING_ACTIVITIES) this.pending.shift();
      }
      return { published: false, reason: error.message, key: rendered.key, queued: true };
    }
  }

  /** Retry every queued activity; anything that fails again stays queued. */
  async flushPending() {
    if (!this.pending.length) return { flushed: 0, remaining: 0 };
    const queued = this.pending;
    this.pending = [];
    let flushed = 0;
    for (const rendered of queued) {
      const result = await this.publish(rendered);
      if (result.published) flushed++;
    }
    return { flushed, remaining: this.pending.length };
  }

  /**
   * The record persisted onto the worktree registry entry, so the next
   * attempt (a CI repair, or a restart after a crash) can resolve stale-vs-new
   * without any webhook state. This is the polling recovery path.
   */
  snapshot() {
    const session = this.session;
    return {
      id: session ? session.id : null,
      attempt: session ? session.attempt : null,
      previousSessionId: session ? session.previousSessionId : null,
      status: session ? session.status : null,
      lastActivityAt: session && session.lastActivityAt ? new Date(session.lastActivityAt).toISOString() : null,
      recoveryFailed: Boolean(session && session.recoveryFailed),
      entitlementDenied: this.entitlementDenied,
      unavailableReason: this.unavailableReason,
      pending: this.pending.map((item) => item.key),
    };
  }
}

/**
 * A bridge that is always `disabled`. The default everywhere, so every
 * existing caller and test keeps today's exact behaviour without opting in.
 */
export function nullAgentSessionBridge() {
  return new AgentSessionBridge({ enabled: false });
}
