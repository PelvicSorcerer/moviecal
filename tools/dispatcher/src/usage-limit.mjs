// The dispatch-time provider usage/rate-limit failure class (MOV-151).
//
// This is a different animal from every other failure the dispatcher knows
// about. `failure-classification.mjs` recognizes a broken *host*;
// `ci-outcomes.mjs` reasons about a failing *PR*. This one recognizes a
// worker that never got to do any work at all because the provider refused
// the session: the `claude`/`codex` process exits non-zero having printed a
// "session limit … resets <time>" message, before any PR exists. Observed
// four times while running the daemon (MOV-105/106 first attempts, MOV-138),
// and until now every one of them was permanently moved to
// `Needs Human Decision` — a human re-queueing work that would simply have
// succeeded an hour later.
//
// The class is deliberately narrow and fails closed in both directions:
//
//   - Any other non-zero exit is not this class and escalates exactly as it
//     does today. A worker whose task genuinely failed must never be quietly
//     retried on a timer.
//   - A message that matches the marker but whose reset time cannot be parsed
//     (or parses to something implausibly far away) escalates too. "Wait
//     until the reset" is the whole mechanism; without a trustworthy reset
//     time there is nothing to wait for, and guessing an interval would turn
//     a bounded retry into a poll loop against a provider that is already
//     refusing us.
//   - Exactly one retry. A second consecutive usage-limit failure on the same
//     issue escalates, because at that point the limit is no longer the
//     transient thing the retry assumed it was.
//
// Pure decision logic plus one persisted store, same split as
// `failure-classification.mjs` + `circuit-breaker.mjs`. The non-terminal
// "awaiting usage reset" Linear state and its restart-safe transition are
// owned by MOV-144; until that exists, the issue is requeued to
// `Ready for Agent` and the deferral below is what stops the next poll cycle
// from immediately re-spending the attempt. That record is persisted outside
// the repo, so a dispatcher restart inside the wait window resumes the wait
// rather than losing it.

import { JsonStateStore } from "./state-store.mjs";

/** The recognized category name, mirroring NESTED_SANDBOX_CRASH's role. */
export const PROVIDER_USAGE_LIMIT = "provider-usage-limit";

/**
 * How far ahead a parsed reset time may be and still be honoured as a wait.
 * A 5-hour session limit and a weekly limit both fit comfortably inside a
 * day; anything beyond that is more likely a misparse than a real wait, and
 * parking an issue for days is worse than asking a human.
 */
export const MAX_USAGE_LIMIT_DEFERRAL_MS = 24 * 60 * 60 * 1000;

// A limit phrase, then a reset word within the same neighbourhood. Both
// halves are required: "rate limit" alone shows up in ordinary application
// logs and test fixtures, and "resets" alone is meaningless.
const USAGE_LIMIT_MARKER_RE =
  /((?:\b\d+\s*-?\s*hour\b[^\n]{0,40})?\b(?:session|usage|rate|weekly|quota)\s+limit\b|\blimit\s+reached\b)([\s\S]{0,240}?\breset(?:s|ting)?\b)/i;

const EPOCH_SECONDS_RE = /\breset(?:s|ting)?\b(?:\s+at)?\s*[:|]?\s*(\d{10})\b/i;
const ISO_RE =
  /\breset(?:s|ting)?\b(?:\s+at)?\s*[:|]?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i;
const RELATIVE_RE = /\b(?:reset(?:s|ting)?\s+in|try\s+again\s+in)\s+([\dhms\s.]+?(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\dhms\s.a-z]{0,20})/i;
const CLOCK_RE = /\breset(?:s|ting)?\b(?:\s+at)?\s*[:|]?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const TIMEZONE_RE = /\(([A-Za-z]+\/[A-Za-z_+\-0-9]+)\)/;

function text(value) {
  return String(value ?? "");
}

/** Wall-clock hour/minute `date` reads as in `timeZone` (or locally when absent). */
function wallClockMinutes(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/**
 * The next instant at which the clock in `timeZone` reads `hour:minute`.
 *
 * Computed as a delta from the current wall clock rather than by
 * constructing a date in that zone, which keeps it dependency-free and
 * correct across the date boundary. A DST transition inside the window can
 * shift the result by an hour; that is immaterial for a retry schedule and
 * far cheaper than carrying a timezone library.
 */
function nextWallClock(now, hour, minute, timeZone) {
  let currentMinutes;
  let zone = timeZone;
  try {
    currentMinutes = wallClockMinutes(now, zone);
  } catch {
    zone = undefined; // an unrecognized IANA name falls back to this Mac's zone
    currentMinutes = wallClockMinutes(now, zone);
  }
  let delta = hour * 60 + minute - currentMinutes;
  if (delta <= 0) delta += 24 * 60;
  return new Date(now.getTime() + delta * 60_000);
}

function parseRelative(spec) {
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  for (const match of spec.matchAll(re)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const scale = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000;
    total += value * scale;
    matched = true;
  }
  return matched ? total : null;
}

/**
 * Extract the reset instant a provider named in its refusal message.
 *
 * Understands the four shapes these CLIs actually emit: a raw epoch stamp
 * (`Claude AI usage limit reached|1757894400`), an ISO timestamp, a relative
 * interval (`resets in 2 hours 30 minutes`), and a bare wall-clock time with
 * an optional IANA zone (`resets 3pm (America/New_York)`).
 *
 * @returns {{resetAt: Date, matched: string, precision: string}|null} null when
 *   no reset time is present, which callers must treat as "cannot schedule a
 *   retry" rather than as an excuse to invent one.
 */
export function parseUsageLimitReset(message, { now = new Date() } = {}) {
  const value = text(message);
  if (!value.trim()) return null;

  const epoch = EPOCH_SECONDS_RE.exec(value);
  if (epoch) return { resetAt: new Date(Number(epoch[1]) * 1000), matched: epoch[0].trim(), precision: "epoch" };

  const iso = ISO_RE.exec(value);
  if (iso) {
    const parsed = new Date(iso[1].replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime())) return { resetAt: parsed, matched: iso[0].trim(), precision: "iso" };
  }

  const relative = RELATIVE_RE.exec(value);
  if (relative) {
    const offsetMs = parseRelative(relative[1]);
    if (offsetMs != null) {
      return { resetAt: new Date(now.getTime() + offsetMs), matched: relative[0].trim(), precision: "relative" };
    }
  }

  const clock = CLOCK_RE.exec(value);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    const meridiem = clock[3]?.toLowerCase();
    if (minute > 59) return null;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    // Without an am/pm a bare hour over 23 is not a time at all.
    if (hour > 23) return null;
    const timeZone = TIMEZONE_RE.exec(value)?.[1];
    return {
      resetAt: nextWallClock(now, hour, minute, timeZone),
      matched: clock[0].trim(),
      precision: timeZone ? "wall-clock-zoned" : "wall-clock-local",
    };
  }

  return null;
}

/**
 * Does a failed worker run carry the provider usage/rate-limit signature?
 *
 * @param {object} args
 * @param {number} args.exitCode - a zero exit is never this class; the worker ran
 * @param {string} args.logTail - combined stdout/stderr tail (worker-spawn.mjs's tailLogs())
 * @param {Date} [args.now]
 * @returns {{category: string, resetAt: string|null, evidence: string, precision: string|null}|null}
 *   null when the run is an ordinary failure, which the caller must keep
 *   handling exactly as it does today.
 */
export function classifyUsageLimitFailure({ exitCode, logTail, now = new Date() } = {}) {
  if (exitCode === 0) return null;
  const tail = text(logTail);
  const marker = USAGE_LIMIT_MARKER_RE.exec(tail);
  if (!marker) return null;
  const evidence = marker[0].replace(/\s+/g, " ").trim().slice(0, 300);
  const reset = parseUsageLimitReset(tail.slice(marker.index), { now });
  return {
    category: PROVIDER_USAGE_LIMIT,
    resetAt: reset ? reset.resetAt.toISOString() : null,
    precision: reset?.precision ?? null,
    evidence,
  };
}

/**
 * Decide what a recognized usage-limit failure means for this issue, given
 * what happened last time.
 *
 * @param {object} args
 * @param {object|null} args.classification - from classifyUsageLimitFailure
 * @param {object|null} [args.previous] - this issue's stored record, if any
 * @param {Date} [args.now]
 * @param {number} [args.maxDeferralMs]
 * @returns {{action: "retry-at-reset"|"escalate"|"not-applicable", reason: string|null, retryAt: string|null, consecutive: number}}
 */
export function decideUsageLimitOutcome({
  classification,
  previous = null,
  now = new Date(),
  maxDeferralMs = MAX_USAGE_LIMIT_DEFERRAL_MS,
} = {}) {
  if (!classification || classification.category !== PROVIDER_USAGE_LIMIT) {
    return { action: "not-applicable", reason: null, retryAt: null, consecutive: 0 };
  }
  const consecutive = (previous?.consecutive || 0) + 1;

  if (!classification.resetAt) {
    return {
      action: "escalate",
      reason:
        "worker reported a provider usage limit but no reset time could be parsed from its message, so no retry can be scheduled",
      retryAt: null,
      consecutive,
    };
  }

  const resetAt = new Date(classification.resetAt);
  if (Number.isNaN(resetAt.getTime())) {
    return {
      action: "escalate",
      reason: `worker reported a provider usage limit with an unusable reset time (${classification.resetAt})`,
      retryAt: null,
      consecutive,
    };
  }
  if (resetAt.getTime() - now.getTime() > maxDeferralMs) {
    return {
      action: "escalate",
      reason: `parsed provider usage-limit reset ${resetAt.toISOString()} is more than ${Math.round(maxDeferralMs / 3_600_000)}h away, which is longer than this dispatcher will park an issue`,
      retryAt: null,
      consecutive,
    };
  }
  if (consecutive > 1) {
    return {
      action: "escalate",
      reason: `second consecutive provider usage-limit failure on this issue (previous retry was scheduled for ${previous?.retryAt || "an earlier reset"}); the limit is not behaving transiently`,
      retryAt: null,
      consecutive,
    };
  }

  // A reset already in the past means the window lifted between the worker's
  // message and this decision; retry on the next poll rather than waiting.
  const retryAt = new Date(Math.max(resetAt.getTime(), now.getTime()));
  return {
    action: "retry-at-reset",
    reason: `provider usage limit reached before any work was published; retrying once at the reported reset (${retryAt.toISOString()})`,
    retryAt: retryAt.toISOString(),
    consecutive,
  };
}

/**
 * Per-issue record of dispatch-time usage-limit failures.
 *
 * Keyed by Linear identifier, persisted at
 * `~/.config/moviecal/usage-limits.json`. Two things live here and both have
 * to survive a restart: the scheduled retry time (so the next poll cycle
 * waits instead of immediately re-spending the attempt) and the consecutive
 * counter (so the second occurrence escalates rather than scheduling a second
 * "single" retry).
 */
export class UsageLimitStore extends JsonStateStore {
  get label() {
    return "usage-limit state";
  }

  get(issueId) {
    return this.load()[issueId] || null;
  }

  /** Record one usage-limit failure and its scheduled retry, incrementing the consecutive counter. */
  record(issueId, { retryAt = null, evidence = null, consecutive, now = new Date() } = {}) {
    return this.update((state) => {
      const previous = state[issueId];
      const record = {
        issue: issueId,
        consecutive: consecutive ?? (previous?.consecutive || 0) + 1,
        retryAt,
        evidence,
        observedAt: now.toISOString(),
      };
      state[issueId] = record;
      return record;
    });
  }

  /**
   * Forget this issue's usage-limit history. Called on any outcome that is
   * *not* a usage-limit failure — a success, or a failure of any other kind —
   * because the escalation rule is about *consecutive* occurrences.
   */
  clear(issueId) {
    const state = this.load();
    if (!state[issueId]) return;
    delete state[issueId];
    this.save(state);
  }

  /**
   * Should dispatch of this issue be held off right now?
   *
   * Deliberately silent: the poll loop asks this every cycle, and the reason
   * for the wait was already published to Linear once, when the retry was
   * scheduled. Commenting again every 30 seconds would bury it.
   */
  deferral(issueId, now = new Date()) {
    const record = this.get(issueId);
    if (!record?.retryAt) return { deferred: false, until: null, reason: null };
    const until = new Date(record.retryAt);
    if (Number.isNaN(until.getTime()) || now.getTime() >= until.getTime()) {
      return { deferred: false, until: record.retryAt, reason: null };
    }
    return {
      deferred: true,
      until: record.retryAt,
      reason: `awaiting the provider usage-limit reset at ${record.retryAt}`,
    };
  }
}
