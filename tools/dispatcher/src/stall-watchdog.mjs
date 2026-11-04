// The stall watchdog pass (MOV-503).
//
// An issue can sit in `Agent Working` or `In Review` with nothing happening
// and no ask (a worker died without a terminal event, an outside outage, a
// green PR waiting for a human merge). This pass turns such a silence into one
// escalation through the single MOV-502 helper (`owner-escalation.mjs`).
//
// What counts as progress -- anything that changes the issue's *fingerprint*:
//   - its workflow state;
//   - a dispatcher-authored comment (the watchdog's own `Needs you:` asks and
//     the edited-in-place CI status comment, whose id never changes, do not
//     count);
//   - a live worker in the active-attempt registry (a live worker keeps the
//     clock reset on every pass, so it is never flagged however long it runs);
//   - for `In Review`, the PR head SHA and its required check conclusions.
//
// The fingerprint and the time it was first seen live in a durable ledger, so
// a restart does not restart the clock. An escalation is keyed on issue, state,
// fingerprint and episode start, and recorded in the owner-notification
// ledger: at most once per stall episode, and a later episode escalates again.

import { JsonStateStore } from "./state-store.mjs";
import { isAuditDue } from "./issue-spec-audit.mjs";

export const WORKING_STATE = "Agent Working";
export const REVIEW_STATE = "In Review";
export const STALL_WATCHED_STATES = [WORKING_STATE, REVIEW_STATE];

const HOUR_MS = 60 * 60 * 1000;
const PASSING = new Set(["success", "skipped", "neutral"]);

/** Persisted `{ lastRunAt }` for the pass cadence. A damaged file reads as "never run". */
export class StallWatchdogScheduleStore extends JsonStateStore {
  get label() {
    return "stall watchdog schedule";
  }

  loadOrReset() {
    try {
      return this.load();
    } catch {
      return {};
    }
  }
}

export { isAuditDue as isStallWatchdogDue };

/** Durable per-issue `{ state, fingerprint, since }` (since = epoch ms). */
export class StallLedger extends JsonStateStore {
  get label() {
    return "stall watchdog ledger";
  }

  episode(issueId) {
    return this.load().issues?.[issueId] || null;
  }

  setEpisode(issueId, record) {
    this.update((state) => {
      state.issues = { ...(state.issues || {}), [issueId]: record };
    });
  }
}

/** True when every required check has passed and nothing is pending or missing. */
export function isPrGreen(pr) {
  const checks = pr?.checks;
  if (!checks) return false;
  const required = checks.required || [];
  return required.length > 0
    && required.every((check) => PASSING.has(check.outcome))
    && !checks.pending
    && !checks.timedOut
    && (checks.missingRequired || []).length === 0;
}

/** Required checks that are not passing, as `name (outcome)`. */
export function nonPassingChecks(pr) {
  const checks = pr?.checks || {};
  const bad = (checks.required || []).filter((check) => !PASSING.has(check.outcome)).map((check) => `${check.name} (${check.outcome})`);
  const missing = (checks.missingRequired || []).map((name) => `${name} (missing)`);
  return [...bad, ...missing];
}

function isDispatcherComment(comment, botUserIds) {
  return Boolean(comment.isBot || (comment.authorId && botUserIds.includes(comment.authorId)));
}

function isWatchdogAsk(comment) {
  return String(comment.body || "").startsWith("Needs you:");
}

function isCiStatusComment(comment) {
  return String(comment.body || "").startsWith("**CI observation (read-only)**");
}

/** The newest dispatcher-authored comment that counts as progress, or null. */
export function lastDispatcherEvent(comments = [], botUserIds = []) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (isDispatcherComment(comment, botUserIds) && !isWatchdogAsk(comment) && !isCiStatusComment(comment)) return comment;
  }
  return null;
}

/** Stable fingerprint of everything that counts as progress. */
export function stallFingerprint({ stateName, live, event, pr }) {
  const parts = [stateName, live ? "live" : "idle", event?.id || "no-event"];
  if (stateName === REVIEW_STATE) {
    const checks = (pr?.checks?.required || []).map((check) => `${check.name}=${check.outcome}`).sort();
    parts.push(pr?.headSha || "no-head", checks.join(","), (pr?.checks?.missingRequired || []).join(","));
  }
  return parts.join("|");
}

/**
 * Pure classification: is an issue stalled, and which kind?
 * @returns {null | {kind: "no-worker"|"green"|"stale-ci", idleMs: number}}
 */
export function classifyStall({ stateName, live, pr, sinceMs, nowMs, thresholds }) {
  const idleMs = nowMs - sinceMs;
  if (stateName === WORKING_STATE) {
    return !live && idleMs >= thresholds.agentWorkingMs ? { kind: "no-worker", idleMs } : null;
  }
  if (stateName === REVIEW_STATE) {
    if (idleMs < thresholds.inReviewMs) return null;
    return { kind: isPrGreen(pr) ? "green" : "stale-ci", idleMs };
  }
  return null;
}

/** Episode escalation key: issue, state, fingerprint and the episode start. */
export function stallEscalationKey({ issueId, stateName, fingerprint, since }) {
  return `stall:${issueId}:${stateName}:${fingerprint}:${since}`;
}

function hours(ms) {
  return Math.max(1, Math.round(ms / HOUR_MS));
}

function prLabelOf(pr) {
  if (!pr?.prNumber) return "its PR (none observed)";
  return `PR #${pr.prNumber}${pr.prUrl ? ` (${pr.prUrl})` : ""}`;
}

function describeEvent(event) {
  if (!event) return "No dispatcher comment was found on the issue.";
  const firstLine = String(event.body).split("\n").find((line) => line.trim()) || "(empty comment)";
  return `Last dispatcher event${event.createdAt ? ` (${event.createdAt})` : ""}: ${firstLine.trim().slice(0, 200)}`;
}

/** The stall-specific escalation content for one classified stall. */
export function stallEscalationFor({ stall, issue, event, pr }) {
  const idle = hours(stall.idleMs);
  if (stall.kind === "no-worker") {
    return {
      ask: `no worker has run for ${idle}h`,
      evidence: [`**Stalled** — ${issue.identifier} has been in \`${WORKING_STATE}\` for ${idle}h with no live worker and no dispatcher activity.`, describeEvent(event)].join("\n"),
      options: [
        "Move the issue to `Ready for Agent` to requeue it for a fresh worker.",
        "Resume it by hand (see `docs/operators/local-execution.md`) if the worktree has useful work.",
        "Move it to `Canceled` to drop it.",
      ],
      mentionOnly: false,
    };
  }
  if (stall.kind === "green") {
    return {
      ask: `${prLabelOf(pr)} is green and waiting for review or merge`,
      evidence: `**Waiting on you** — every required check on ${prLabelOf(pr)} (head \`${pr.headSha}\`) has passed and nothing has changed for ${idle}h. The issue stays \`${REVIEW_STATE}\`.`,
      options: ["Review and merge the PR; the dispatcher then moves the issue to `Done`.", "Close the PR to drop it."],
      mentionOnly: true,
    };
  }
  const bad = nonPassingChecks(pr);
  return {
    ask: `${prLabelOf(pr)} has had no CI or commit change for ${idle}h`,
    evidence: [`**Stalled** — no head SHA or check change on ${prLabelOf(pr)} for ${idle}h.`, `Failing or pending checks: ${bad.length ? bad.join(", ") : "none named"}.`].join("\n"),
    options: [
      "Move the issue back to `Ready for Agent` to retry.",
      "Fix the PR yourself and push; the dispatcher keeps observing it.",
      "Close the PR to drop it.",
    ],
    mentionOnly: false,
  };
}

/**
 * Run one watchdog pass.
 *
 * @param {object} args
 * @param {object[]} args.issues - `issuesForStallWatch()` output (delegated, in a watched state)
 * @param {object} args.linearClient
 * @param {StallLedger} args.stallLedger
 * @param {object} args.ownerLedger - OwnerNotificationLedger
 * @param {(issueId: string) => boolean} args.isLive - active-attempt registry lookup
 * @param {(issue: object) => object|null} args.observePr - PR head + checks for an In Review issue
 * @param {Function} args.escalateToOwner
 * @param {string|null} args.needsHumanDecisionStateId
 * @param {{agentWorkingMs: number, inReviewMs: number}} args.thresholds
 * @param {() => Date} [args.now]
 */
export async function runStallWatchdog({
  issues,
  linearClient,
  stallLedger,
  ownerLedger,
  isLive,
  observePr,
  escalateToOwner,
  needsHumanDecisionStateId,
  thresholds,
  botUserIds = [],
  now = () => new Date(),
  logger = console,
}) {
  const nowMs = now().getTime();
  const results = [];
  for (const issue of issues) {
    const stateName = issue.stateName;
    if (!STALL_WATCHED_STATES.includes(stateName)) continue;
    if (!issue.delegate || (botUserIds.length > 0 && !botUserIds.includes(issue.delegate.id))) continue;

    const live = Boolean(isLive(issue.id));
    let pr = null;
    if (stateName === REVIEW_STATE) {
      pr = observePr(issue);
      // An unreadable PR is not evidence of a stall or of progress: skip this pass.
      if (pr?.observationError) { results.push({ issue: issue.identifier, action: "skipped", reason: "PR observation failed" }); continue; }
    }
    const event = lastDispatcherEvent(issue.comments, botUserIds);
    const fingerprint = stallFingerprint({ stateName, live, event, pr });

    let episode = stallLedger.episode(issue.id);
    if (!episode || episode.state !== stateName || episode.fingerprint !== fingerprint) {
      // First sight of an idle issue dates the silence from its last event.
      const eventMs = event?.createdAt ? Date.parse(event.createdAt) : NaN;
      const since = !episode && !live && Number.isFinite(eventMs) ? Math.min(eventMs, nowMs) : nowMs;
      episode = { state: stateName, fingerprint, since };
      stallLedger.setEpisode(issue.id, episode);
    } else if (live) {
      // A live worker is progress on every pass, however long it runs.
      episode = { ...episode, since: nowMs };
      stallLedger.setEpisode(issue.id, episode);
    }

    const stall = classifyStall({ stateName, live, pr, sinceMs: episode.since, nowMs, thresholds });
    if (!stall) { results.push({ issue: issue.identifier, action: "ok" }); continue; }

    const key = stallEscalationKey({ issueId: issue.id, stateName, fingerprint, since: episode.since });
    if (ownerLedger.hasEscalation(key)) { results.push({ issue: issue.identifier, action: "already-escalated", kind: stall.kind }); continue; }

    const content = stallEscalationFor({ stall, issue, event, pr });
    if (!content.mentionOnly && !needsHumanDecisionStateId) {
      logger.warn?.(`${issue.identifier}: stalled but no Needs Human Decision state is available`);
      results.push({ issue: issue.identifier, action: "skipped", reason: "no needs-state", kind: stall.kind });
      continue;
    }
    // Mention-only (green PR): no state id, so the helper posts the ask and
    // leaves the workflow state untouched.
    const outcome = await escalateToOwner({
      linearClient,
      issue,
      stateId: content.mentionOnly ? null : needsHumanDecisionStateId,
      ask: content.ask,
      evidence: content.evidence,
      options: content.options,
      key,
      ledger: ownerLedger,
      botUserIds,
      logger,
      now,
    });
    results.push({ issue: issue.identifier, action: outcome.escalated ? "escalated" : "already-escalated", kind: stall.kind });
  }
  return results;
}
