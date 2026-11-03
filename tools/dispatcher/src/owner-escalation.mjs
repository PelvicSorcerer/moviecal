// The single path by which the dispatcher asks its human owner for anything
// (MOV-502).
//
// Contract: the owner stays the assignee (Linear refuses delegation to an
// unowned issue). Linear auto-subscribes assignees and an app actor cannot
// unsubscribe them (issueUnsubscribe reports success but does nothing), so
// the owner's inbox cannot be quieted from the dispatcher. The dispatcher
// instead @mentions the owner exactly when it moves an issue to `Needs Human
// Decision` / `Needs Input`, so a mention always means "needs you".
//
// Every move into a needs-state goes through `escalateToOwner`;
// owner-escalation.test.mjs statically fails if a new direct `moveToState` to
// one appears elsewhere.

import { JsonStateStore } from "./state-store.mjs";

const DEFAULT_OPTIONS = [
  "Move the issue back to `Ready for Agent` to retry once the cause is resolved.",
  "Move it to `Canceled` to drop it.",
];

/** Durable per-key escalation record. */
export class OwnerNotificationLedger extends JsonStateStore {
  get label() {
    return "owner notification ledger";
  }

  hasEscalation(key) {
    return Boolean(this.load().escalations?.[key]);
  }

  recordEscalation(key, at) {
    this.update((state) => {
      state.escalations = { ...(state.escalations || {}), [key]: { at } };
    });
  }
}

/** Why `issue`'s assignee cannot be @mentioned, or the mention to use. */
export function ownerMention(issue, { botUserIds = [] } = {}) {
  const assignee = issue && issue.assignee;
  if (!assignee || !assignee.id) return { mention: null, reason: "issue has no assignee" };
  if (assignee.isApp || botUserIds.includes(assignee.id)) return { mention: null, reason: "assignee is a bot or app user" };
  if (!assignee.displayName) return { mention: null, reason: "assignee has no Linear username" };
  const workspace = /^https:\/\/linear\.app\/([^/]+)\//.exec(String(issue.url || ""))?.[1];
  if (!workspace) return { mention: null, reason: "issue URL does not name the Linear workspace" };
  return { mention: `https://linear.app/${workspace}/profiles/${encodeURIComponent(assignee.displayName)}`, reason: null };
}

/** Render the one escalation comment. The first line is always `Needs you: <ask>`. */
export function renderEscalationComment({ ask, evidence, options, mention }) {
  const oneLine = String(ask).replace(/\s+/g, " ").trim();
  const steps = options.length > 0 ? options : DEFAULT_OPTIONS;
  return [
    `Needs you: ${oneLine}`,
    ...(mention ? ["", mention] : []),
    "",
    String(evidence).trim(),
    "",
    "**What you can do next**",
    ...steps.map((step) => `- ${step}`),
  ].join("\n");
}

/**
 * Post one comment that @mentions the assignee, then move `issue` to a
 * needs-state. Idempotent per `key` when a `ledger` is supplied.
 *
 * @param {object} args
 * @param {object} args.linearClient
 * @param {{id: string, url?: string, assignee?: object|null}} args.issue
 * @param {string} args.stateId - the `Needs Human Decision` / `Needs Input` state id
 * @param {string} args.ask - one line: what the owner must decide or do
 * @param {string} args.evidence - markdown; the reason text of the escalation site
 * @param {string[]} [args.options] - what each human action does next
 * @param {string} [args.key] - escalation identity; a repeat is a no-op
 * @param {OwnerNotificationLedger} [args.ledger]
 * @param {string[]} [args.botUserIds]
 */
export async function escalateToOwner({
  linearClient,
  issue,
  stateId,
  ask,
  evidence,
  options = [],
  key = null,
  ledger = null,
  botUserIds = [],
  logger = console,
  now = () => new Date(),
}) {
  if (key && ledger && ledger.hasEscalation(key)) return { escalated: false, reason: "already escalated", key };

  let target = issue;
  if (target.assignee === undefined && typeof linearClient.issueSnapshot === "function") {
    try {
      const snapshot = await linearClient.issueSnapshot(target.id);
      if (snapshot) target = { ...snapshot, ...target, assignee: snapshot.assignee, url: target.url || snapshot.url };
    } catch (error) {
      logger.warn?.(`${target.identifier || target.id}: could not read the assignee for an escalation mention: ${error.message}`);
    }
  }

  const { mention, reason } = ownerMention(target, { botUserIds });
  if (!mention) logger.warn?.(`${target.identifier || target.id}: escalating without an @mention (${reason})`);

  // Comment first: the mention is the notification, so a failure after it
  // leaves a loud ask instead of an issue silently parked in a needs-state.
  const body = renderEscalationComment({ ask, evidence, options, mention });
  await linearClient.addComment(target.id, body);
  if (stateId) await linearClient.moveToState(target.id, stateId);
  if (key && ledger) ledger.recordEscalation(key, now().toISOString());
  return { escalated: true, mentioned: Boolean(mention), body, key };
}

/** The workflow-state ids a `stateIds` map designates as needs-human states. */
export function needsStateIds(stateIds = {}) {
  return [stateIds.needsHumanDecision, stateIds.needsInput].filter(Boolean);
}

/** User ids that are the dispatcher itself and so can never be @mentioned. */
export function botUserIdsOf(delegate) {
  return delegate && delegate.id ? [delegate.id] : [];
}
