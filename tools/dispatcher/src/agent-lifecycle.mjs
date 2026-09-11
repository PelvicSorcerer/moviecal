// One semantic lifecycle for a dispatcher attempt
// (MOV-169, extracted from MOV-158).
//
// Before this existed, `run-loop.mjs` wrote each transition by hand as an
// ad-hoc `moveToState` + `addComment` pair. That was fine while comments were
// the only surface; it stops being fine the moment a second surface (Linear
// Agent Activities) can exist, because "the same transition" would then have
// to be written twice, in two voices, kept in sync by hand.
//
// So the dispatcher describes a transition **once** — a `kind`, a plain-text
// `summary`, and the markdown blocks a human needs — and this publisher picks
// exactly one surface for it:
//
//   1. a first-class **Agent Activity**, when the session bridge has a live
//      session (feature-gated, off by default, unavailable today per MOV-141);
//   2. otherwise a human-readable **app-actor comment**, which is the complete
//      operational record and always has been.
//
// Workflow **state** transitions are not part of that either/or. State is
// durable control data that Linear's own views, the promoter, and
// `pr-reconcile.mjs` all read; it is written on every publish that carries a
// `stateId`, whichever presentation surface won. Sessions and comments are
// presentation and history — the issue, branch, and PR are the identity.
//
// All I/O is injected. Nothing here throws into the dispatch path on an Agent
// Session problem: the bridge swallows those and reports `published: false`,
// which simply routes the event to the comment surface instead.

import { nullAgentSessionBridge, renderLifecycleEvent } from "./agent-session.mjs";

/**
 * Publishes an attempt's lifecycle to Linear on whichever surface is
 * available, and remembers what it already published so a repeated call is a
 * no-op rather than a duplicate.
 */
export class LifecyclePublisher {
  /**
   * @param {object} opts
   * @param {object} opts.linearClient - LinearClient (or a fake) with addComment/moveToState
   * @param {import("./agent-session.mjs").AgentSessionBridge} [opts.bridge]
   * @param {object} [opts.context] - durable identity carried on every event: {issue, branch, prUrl, worker, model, worktreePath}
   * @param {{error: Function}} [opts.logger]
   */
  constructor({ linearClient, bridge = nullAgentSessionBridge(), context = {}, logger = console } = {}) {
    if (!linearClient) throw new Error("LifecyclePublisher requires a linearClient");
    this.linearClient = linearClient;
    this.bridge = bridge;
    this.context = { ...context };
    this.logger = logger;
    this.published = new Set();
  }

  /** Merge newly-learned identity (a PR URL, the resolved attempt number) into every later event. */
  setContext(patch = {}) {
    this.context = { ...this.context, ...patch };
    return this.context;
  }

  /**
   * Open (or attach to) the Agent Session for this attempt. Safe and cheap
   * when sessions are disabled — it still resolves the attempt number, which
   * is what keeps a CI repair's activities numbered and linked to the session
   * they continue.
   */
  async begin({ existing = null } = {}) {
    const issue = this.context.issue || {};
    const result = await this.bridge.begin(issue, { existing });
    this.setContext({
      attempt: result.decision ? result.decision.attempt : 1,
      previousSessionId: result.decision ? result.decision.previousSessionId : null,
    });
    return result;
  }

  /**
   * Publish one lifecycle transition.
   *
   * @param {string} kind - one of AGENT_EVENT_KINDS
   * @param {object} fields
   * @param {string} fields.summary - plain-text one-liner (required)
   * @param {string} [fields.headline] - markdown override for the comment's first line
   * @param {string[]} [fields.sections] - extra markdown blocks for the comment
   * @param {string} [fields.detail] - extra plain text for the activity body
   * @param {string} [fields.action] - imperative label for `progress`/`pr-opened`
   * @param {string} [fields.stateId] - workflow state to move the issue to first
   * @returns {Promise<{surface: string, key: string|null, reason: string|null}>}
   */
  async publish(kind, fields = {}) {
    const issue = this.context.issue || {};
    let rendered;
    try {
      rendered = renderLifecycleEvent({ ...this.context, ...fields, kind });
    } catch (error) {
      // A malformed event is this dispatcher's own bug, not the issue's
      // problem: log it and drop it rather than fail an attempt that worked.
      this.logger.error(`Refusing to publish a malformed lifecycle event: ${error.message}`);
      return { surface: "none", key: null, reason: error.message };
    }

    if (this.published.has(rendered.key)) {
      return { surface: "none", key: rendered.key, reason: "already published" };
    }
    this.published.add(rendered.key);

    if (fields.stateId) {
      await this.linearClient.moveToState(issue.id, fields.stateId);
    }

    const sessionResult = await this.bridge.publish(rendered);
    if (sessionResult.published) {
      return { surface: "agent-activity", key: rendered.key, reason: null };
    }
    await this.linearClient.addComment(issue.id, rendered.comment);
    return { surface: "comment", key: rendered.key, reason: sessionResult.reason || null };
  }

  /**
   * Move the issue's workflow state without publishing anything on either
   * presentation surface. For the rare transition that is pure control state.
   */
  async moveState(stateId) {
    const issue = this.context.issue || {};
    await this.linearClient.moveToState(issue.id, stateId);
  }

  /**
   * Retry activities queued by a transient Linear failure. Called on a later
   * poll cycle: this queue, not a webhook, is what makes activity publication
   * eventually consistent (acceptance criterion 7).
   */
  async flushPending() {
    return this.bridge.flushPending();
  }

  /** The session record to persist on the worktree registry entry. */
  snapshot() {
    return this.bridge.snapshot();
  }
}
