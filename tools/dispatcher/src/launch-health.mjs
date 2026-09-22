// Persistent, non-secret health signals for the launchd dispatcher.
//
// A LaunchAgent can be alive while making no useful progress (for example,
// when its non-interactive `gh` credential has expired).  This module makes
// that state explicit before the dispatcher observes or mutates any PR, and
// records the bounded first-poll result outside the repository.

import { execFileSync } from "node:child_process";
import { JsonStateStore } from "./state-store.mjs";

export const DEFAULT_FIRST_POLL_TIMEOUT_MS = 120_000;

function messageOf(error) {
  return [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
}

/**
 * Turn a `gh auth status` failure into operator guidance without copying
 * command output into dispatcher logs (which may contain credential-shaped
 * material supplied by an external tool).
 */
export function classifyGithubAuthFailure(error) {
  const message = messageOf(error);
  if (error?.code === "ENOENT" || /not found|enoent/i.test(message)) {
    return {
      kind: "gh-not-found",
      diagnostic: "GitHub CLI is unavailable on the LaunchAgent PATH; restore the plist PATH and restart the dispatcher.",
    };
  }
  if (/requires authentication|not logged into|authentication failed|http 401|bad credentials/i.test(message)) {
    return {
      kind: "gh-auth-unavailable",
      diagnostic: "GitHub CLI authentication is unavailable; run `gh auth login -h github.com` as the LaunchAgent user, then restart the dispatcher.",
    };
  }
  return {
    kind: "gh-auth-check-failed",
    diagnostic: "GitHub CLI authentication could not be verified; run `gh auth status` as the LaunchAgent user, repair it, then restart the dispatcher.",
  };
}

/** A fail-closed, intentionally quiet GitHub CLI auth check. */
export function checkGithubCliAuth({ run = execFileSync } = {}) {
  try {
    run("gh", ["auth", "status"], { encoding: "utf8", stdio: "pipe" });
    return { ok: true, kind: "ok", diagnostic: null };
  } catch (error) {
    return { ok: false, ...classifyGithubAuthFailure(error) };
  }
}

/**
 * One durable record for the currently-starting (or most recently-started)
 * dispatcher. It contains timestamps and classifications only — never a
 * command's output, token, or environment.
 */
export class DispatcherLaunchHealthStore extends JsonStateStore {
  get label() {
    return "dispatcher launch health state";
  }

  beginFirstPoll({ now = new Date(), timeoutMs = DEFAULT_FIRST_POLL_TIMEOUT_MS } = {}) {
    const startedAt = now.toISOString();
    const deadlineAt = new Date(now.getTime() + timeoutMs).toISOString();
    const record = {
      status: "starting",
      startedAt,
      deadlineAt,
      firstPollCompletedAt: null,
      failureKind: null,
      diagnostic: null,
    };
    this.save(record);
    return record;
  }

  completeFirstPoll({ now = new Date() } = {}) {
    return this.update((record) => {
      record.status = "healthy";
      record.firstPollCompletedAt = now.toISOString();
      record.failureKind = null;
      record.diagnostic = null;
      return record;
    });
  }

  failFirstPoll({ kind, diagnostic, now = new Date() } = {}) {
    return this.update((record) => {
      record.status = "failed";
      record.firstPollCompletedAt = now.toISOString();
      record.failureKind = kind || "startup-failed";
      record.diagnostic = diagnostic || "Dispatcher startup failed before completing its first poll.";
      return record;
    });
  }

  /** Read-only status view; an old `starting` record is visibly overdue. */
  status({ now = new Date() } = {}) {
    const record = this.load();
    if (!record.status) return { status: "unknown", diagnostic: "No dispatcher startup health record exists yet." };
    if (record.status === "starting" && record.deadlineAt && new Date(record.deadlineAt).getTime() < now.getTime()) {
      return {
        ...record,
        status: "overdue",
        diagnostic: "The dispatcher did not record its first completed poll before the startup deadline. Inspect dispatcher.stderr.log, then restart it with launchctl kickstart -k.",
      };
    }
    return record;
  }
}
