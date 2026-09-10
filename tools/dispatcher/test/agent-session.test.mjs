import { describe, it, expect, vi } from "vitest";
import {
  AgentSessionBridge,
  AGENT_EVENT_KINDS,
  MAX_PENDING_ACTIVITIES,
  SESSION_STATUS,
  STALE_SESSION_MS,
  activityFor,
  commentFor,
  createAgentSessionCapability,
  durableIdentity,
  isAgentSessionsUnavailableError,
  nullAgentSessionBridge,
  renderLifecycleEvent,
  resolveSessionForAttempt,
} from "../src/agent-session.mjs";

const ISSUE = { id: "uuid-1", identifier: "MOV-158", url: "https://linear.app/moviecal/issue/MOV-158" };

function baseEvent(overrides = {}) {
  return {
    kind: "acknowledged",
    summary: "Dispatcher picked up MOV-158 on the local Mac adapter.",
    issue: ISSUE,
    branch: "agent/MOV-158-thing",
    ...overrides,
  };
}

/** A Linear client fake exposing exactly the Agent Session surface the bridge uses. */
function fakeSessionClient({ createResult = { id: "session-1" }, createError = null, activityError = null } = {}) {
  return {
    created: [],
    activities: [],
    externalLinks: [],
    createAgentSessionOnIssue: vi.fn(async function ({ issueId }) {
      this.created.push(issueId);
      if (createError) throw createError;
      return createResult;
    }),
    createAgentActivity: vi.fn(async function ({ agentSessionId, content }) {
      if (activityError) throw activityError;
      this.activities.push({ agentSessionId, content });
      return true;
    }),
    updateAgentSessionExternalLink: vi.fn(async function (id, url) {
      this.externalLinks.push({ id, url });
      return true;
    }),
  };
}

describe("isAgentSessionsUnavailableError (MOV-141's live finding)", () => {
  it("recognizes the exact message the workspace returned", () => {
    expect(isAgentSessionsUnavailableError(new Error("Linear API error: agent sessions disabled"))).toBe(true);
  });

  it("recognizes the documented phrasing variants", () => {
    for (const message of [
      "Agent Sessions are disabled",
      "agent sessions are not enabled for this app",
      "agent session feature not entitled",
    ]) {
      expect(isAgentSessionsUnavailableError(new Error(message)), message).toBe(true);
    }
  });

  it("does not mistake a transient failure for a missing entitlement", () => {
    // The whole point of the split: this one must be retried, not latched off.
    expect(isAgentSessionsUnavailableError(new Error("fetch failed"))).toBe(false);
    expect(isAgentSessionsUnavailableError(new Error("Linear API error: rate limited"))).toBe(false);
    expect(isAgentSessionsUnavailableError(null)).toBe(false);
  });
});

describe("durableIdentity", () => {
  it("names the issue, branch, and PR — never the session — as the identity", () => {
    const line = durableIdentity({ issue: ISSUE, branch: "agent/MOV-158-thing", prUrl: "https://gh/pr/1" });
    expect(line).toContain("MOV-158");
    expect(line).toContain("agent/MOV-158-thing");
    expect(line).toContain("https://gh/pr/1");
  });

  it("records the attempt and the session it continues, so a repair reads as the same work", () => {
    const line = durableIdentity({ issue: ISSUE, branch: "b", attempt: 2, previousSessionId: "session-1" });
    expect(line).toContain("attempt 2");
    expect(line).toContain("continues session session-1");
  });

  it("omits an attempt number on the first attempt", () => {
    expect(durableIdentity({ issue: ISSUE, attempt: 1 })).not.toContain("attempt");
  });
});

describe("activity serialization", () => {
  it("rejects a kind outside the published contract", () => {
    expect(() => activityFor(baseEvent({ kind: "freestyle" }))).toThrow(/unknown agent event kind/);
    expect(() => activityFor({ kind: "", summary: "x" })).toThrow(/unknown agent event kind/);
  });

  it("rejects an event with no summary, since both surfaces render from it", () => {
    expect(() => activityFor(baseEvent({ summary: "" }))).toThrow(/carries no summary/);
  });

  it("maps every declared kind to a content type and session status", () => {
    const expected = {
      acknowledged: ["thought", SESSION_STATUS.active],
      plan: ["thought", SESSION_STATUS.active],
      repair: ["thought", SESSION_STATUS.active],
      progress: ["action", SESSION_STATUS.active],
      "pr-opened": ["action", SESSION_STATUS.active],
      "waiting-input": ["elicitation", SESSION_STATUS.awaitingInput],
      error: ["error", SESSION_STATUS.error],
      stopped: ["response", SESSION_STATUS.complete],
      complete: ["response", SESSION_STATUS.complete],
    };
    // A new kind added to AGENT_EVENT_KINDS without a mapping fails here rather
    // than at runtime on a live issue.
    expect(Object.keys(expected).sort()).toEqual([...AGENT_EVENT_KINDS].sort());
    for (const [kind, [type, status]] of Object.entries(expected)) {
      const result = activityFor(baseEvent({ kind, summary: `${kind} happened` }));
      expect(result.content.type, kind).toBe(type);
      expect(result.sessionStatus, kind).toBe(status);
    }
  });

  it("carries the PR URL both as an external link and inside the activity body", () => {
    // Deliberate redundancy: the external-link mutation shape is unverified
    // against a live session, so a wrong field name there must not lose the link.
    const result = activityFor(baseEvent({ kind: "pr-opened", summary: "Pull request opened: https://gh/pr/7", prUrl: "https://gh/pr/7" }));
    expect(result.externalUrl).toBe("https://gh/pr/7");
    expect(result.content.result).toContain("https://gh/pr/7");
  });

  it("puts the durable identity in the activity body", () => {
    const result = activityFor(baseEvent({ kind: "repair", summary: "Repairing CI", prUrl: "https://gh/pr/7", attempt: 2 }));
    expect(result.content.body).toContain("MOV-158");
    expect(result.content.body).toContain("https://gh/pr/7");
    expect(result.content.body).toContain("attempt 2");
  });
});

describe("comment serialization (the fallback surface)", () => {
  it("bolds the summary when no explicit headline is given", () => {
    expect(commentFor(baseEvent({ summary: "Dispatcher started work." }))).toBe("**Dispatcher started work.**");
  });

  it("preserves an exact legacy headline, because other code reads these strings back", () => {
    // promoter.mjs parses "**Dispatcher preflight failed:** …"; operators grep
    // for the rest. A summary-derived headline would silently break both.
    const comment = commentFor(
      baseEvent({ kind: "error", summary: "Worker exited with code 1.", headline: "**Worker exited with code 1.**", sections: ["```", "boom", "```"] }),
    );
    expect(comment).toBe("**Worker exited with code 1.**\n\n```\nboom\n```");
  });

  it("renders sections under a blank line", () => {
    const comment = commentFor(baseEvent({ sections: ["Worktree: `/tmp/wt`", "Branch: `agent/x`"] }));
    expect(comment).toBe("**Dispatcher picked up MOV-158 on the local Mac adapter.**\n\nWorktree: `/tmp/wt`\nBranch: `agent/x`");
  });

  it("preserves sections verbatim, since they carry markdown", () => {
    // Trimming would mangle an indented log tail inside a fence, and dropping
    // empty entries would delete the blank line that separates the closing
    // fence from the run-log path.
    const comment = commentFor(
      baseEvent({
        kind: "error",
        summary: "Worker timed out.",
        sections: ["```", "  indented log line", "```", "", "Full run log: `/tmp/logs/x`"],
      }),
    );
    expect(comment).toBe(
      "**Worker timed out.**\n\n```\n  indented log line\n```\n\nFull run log: `/tmp/logs/x`",
    );
  });

  it("drops only nullish sections, so a `cond ? x : null` caller stays readable", () => {
    expect(commentFor(baseEvent({ sections: ["kept", null, undefined] }))).toBe(
      "**Dispatcher picked up MOV-158 on the local Mac adapter.**\n\nkept",
    );
  });
});

describe("renderLifecycleEvent", () => {
  it("produces both surfaces from one description", () => {
    const rendered = renderLifecycleEvent(baseEvent({ sections: ["Branch: `agent/x`"] }));
    expect(rendered.content.type).toBe("thought");
    expect(rendered.comment).toContain("Branch: `agent/x`");
    expect(rendered.terminal).toBe(false);
  });

  it("gives the same event the same idempotency key and a different event a different one", () => {
    const a = renderLifecycleEvent(baseEvent({ kind: "progress", summary: "ran verify", action: "verify" }));
    const b = renderLifecycleEvent(baseEvent({ kind: "progress", summary: "ran verify", action: "verify" }));
    const c = renderLifecycleEvent(baseEvent({ kind: "progress", summary: "ran browser lane", action: "verify" }));
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it("scopes the key by attempt, so a repair republishes rather than dedupes against attempt 1", () => {
    const first = renderLifecycleEvent(baseEvent({ attempt: 1 }));
    const second = renderLifecycleEvent(baseEvent({ attempt: 2 }));
    expect(first.key).not.toBe(second.key);
  });

  it("marks terminal statuses so a caller can tell a finished session from a live one", () => {
    expect(renderLifecycleEvent(baseEvent({ kind: "complete", summary: "done" })).terminal).toBe(true);
    expect(renderLifecycleEvent(baseEvent({ kind: "error", summary: "boom" })).terminal).toBe(true);
    expect(renderLifecycleEvent(baseEvent({ kind: "waiting-input", summary: "?" })).terminal).toBe(false);
  });
});

describe("resolveSessionForAttempt (stale recovery and new linked attempts)", () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);

  it("creates a first session when nothing was recorded", () => {
    const decision = resolveSessionForAttempt(null, { now });
    expect(decision).toMatchObject({ action: "create", attempt: 1, previousSessionId: null });
  });

  it("attaches to a live session", () => {
    const decision = resolveSessionForAttempt(
      { id: "session-1", status: "active", lastActivityAt: new Date(now - 1000).toISOString(), attempt: 1 },
      { now },
    );
    expect(decision).toMatchObject({ action: "attach", attempt: 1, stale: false });
  });

  it("attaches to a stale session, because the next activity is what recovers it", () => {
    const decision = resolveSessionForAttempt(
      { id: "session-1", status: "active", lastActivityAt: new Date(now - STALE_SESSION_MS - 1).toISOString(), attempt: 1 },
      { now },
    );
    expect(decision).toMatchObject({ action: "attach", stale: true });
    expect(decision.reason).toMatch(/recover/);
  });

  it("opens a new linked session when a stale one already refused a recovery activity", () => {
    const decision = resolveSessionForAttempt(
      {
        id: "session-1",
        status: "active",
        lastActivityAt: new Date(now - STALE_SESSION_MS - 1).toISOString(),
        attempt: 1,
        recoveryFailed: true,
      },
      { now },
    );
    expect(decision).toMatchObject({ action: "create", attempt: 2, previousSessionId: "session-1" });
  });

  it("honours a rejected recovery even once the record no longer looks stale", () => {
    // Attaching updates the recorded activity time, so by the next attempt a
    // recoveryFailed session reads as fresh. The evidence must still win, or a
    // dead session gets attached to forever.
    const decision = resolveSessionForAttempt(
      { id: "session-1", status: "active", lastActivityAt: new Date(now - 1000).toISOString(), attempt: 1, recoveryFailed: true },
      { now },
    );
    expect(decision).toMatchObject({ action: "create", attempt: 2, previousSessionId: "session-1" });
  });

  it.each(["complete", "error", "canceled", "cancelled"])(
    "opens a new linked attempt when the prior session is terminal (%s)",
    (status) => {
      const decision = resolveSessionForAttempt({ id: "session-1", status, attempt: 3 }, { now });
      expect(decision).toMatchObject({ action: "create", attempt: 4, previousSessionId: "session-1" });
      expect(decision.reason).toMatch(/cannot be safely resumed/);
    },
  );

  it("treats a record with no id as no prior session at all", () => {
    expect(resolveSessionForAttempt({ id: "", status: "active" }, { now }).action).toBe("create");
  });

  it("does not call a session with no recorded activity time stale", () => {
    // An unknown last-activity time is not evidence of staleness; guessing
    // would open a redundant new session on every restart.
    expect(resolveSessionForAttempt({ id: "session-1", status: "active", attempt: 1 }, { now }).stale).toBe(false);
  });
});

describe("AgentSessionBridge when sessions are unavailable (today's live state)", () => {
  it("is disabled by default and makes no network call at all", async () => {
    const client = fakeSessionClient();
    const bridge = new AgentSessionBridge({ linearClient: client });

    const begun = await bridge.begin(ISSUE);
    const result = await bridge.publish(renderLifecycleEvent(baseEvent()));

    expect(begun.mode).toBe("disabled");
    expect(bridge.mode).toBe("disabled");
    expect(result.published).toBe(false);
    expect(client.createAgentSessionOnIssue).not.toHaveBeenCalled();
    expect(client.createAgentActivity).not.toHaveBeenCalled();
  });

  it("still resolves the attempt number, which is what keeps a repair linked", async () => {
    const bridge = new AgentSessionBridge({ enabled: false });
    const begun = await bridge.begin(ISSUE, { existing: { id: "session-1", status: "complete", attempt: 1 } });
    expect(begun.decision).toMatchObject({ action: "create", attempt: 2, previousSessionId: "session-1" });
  });

  it("disables itself when enabled without an Agent-Session-capable client", async () => {
    const bridge = new AgentSessionBridge({ enabled: true, linearClient: { addComment: () => {} } });
    expect(bridge.mode).toBe("disabled");
    expect((await bridge.begin(ISSUE)).reason).toMatch(/no Agent-Session-capable Linear client/);
  });

  it("latches the entitlement answer so a rejection is never retried (acceptance criterion 6)", async () => {
    const capability = createAgentSessionCapability();
    const client = fakeSessionClient({ createError: new Error("Linear API error: agent sessions disabled") });

    const first = new AgentSessionBridge({ linearClient: client, enabled: true, capability });
    expect((await first.begin(ISSUE)).mode).toBe("unavailable");
    expect(capability.denied).toBe(true);

    // A second issue, later in the same poll cycle: no second doomed mutation.
    const second = new AgentSessionBridge({ linearClient: client, enabled: true, capability });
    expect((await second.begin({ id: "uuid-2", identifier: "MOV-159" })).mode).toBe("disabled");
    expect(client.createAgentSessionOnIssue).toHaveBeenCalledTimes(1);
  });

  it("does not log an entitlement rejection as an error — it is the documented state, not a fault", async () => {
    const logger = { error: vi.fn() };
    const client = fakeSessionClient({ createError: new Error("agent sessions disabled") });
    await new AgentSessionBridge({ linearClient: client, enabled: true, logger }).begin(ISSUE);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does log a genuine failure, and reports it as unavailable rather than throwing", async () => {
    const logger = { error: vi.fn() };
    const client = fakeSessionClient({ createError: new Error("fetch failed") });
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true, logger });

    const begun = await bridge.begin(ISSUE);

    expect(begun.mode).toBe("unavailable");
    expect(bridge.entitlementDenied).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it("nullAgentSessionBridge is permanently disabled", async () => {
    const bridge = nullAgentSessionBridge();
    expect(bridge.mode).toBe("disabled");
    expect((await bridge.publish(renderLifecycleEvent(baseEvent()))).published).toBe(false);
  });
});

describe("AgentSessionBridge when sessions are available", () => {
  it("creates a session and publishes the activity", async () => {
    const client = fakeSessionClient();
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });

    await bridge.begin(ISSUE);
    const result = await bridge.publish(renderLifecycleEvent(baseEvent()));

    expect(client.created).toEqual(["uuid-1"]);
    expect(result.published).toBe(true);
    expect(client.activities).toHaveLength(1);
    expect(client.activities[0].agentSessionId).toBe("session-1");
  });

  it("attaches to a recorded live session instead of opening a redundant one", async () => {
    const client = fakeSessionClient();
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });

    const begun = await bridge.begin(ISSUE, {
      existing: { id: "session-prior", status: "active", lastActivityAt: new Date().toISOString(), attempt: 1 },
    });

    expect(begun).toMatchObject({ mode: "session", sessionId: "session-prior", attached: true });
    expect(client.createAgentSessionOnIssue).not.toHaveBeenCalled();
  });

  it("sets the session's external URL when the activity carries one", async () => {
    const client = fakeSessionClient();
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });
    await bridge.begin(ISSUE);

    await bridge.publish(renderLifecycleEvent(baseEvent({ kind: "pr-opened", summary: "PR opened", prUrl: "https://gh/pr/9" })));

    expect(client.externalLinks).toEqual([{ id: "session-1", url: "https://gh/pr/9" }]);
  });

  it("treats a failed external-link mutation as non-fatal, since the URL is already in the body", async () => {
    const client = fakeSessionClient();
    client.updateAgentSessionExternalLink = vi.fn(async () => {
      throw new Error("Field 'externalUrl' is not defined");
    });
    const logger = { error: vi.fn() };
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true, logger });
    await bridge.begin(ISSUE);

    const result = await bridge.publish(
      renderLifecycleEvent(baseEvent({ kind: "pr-opened", summary: "PR opened", prUrl: "https://gh/pr/9" })),
    );

    expect(result.published).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it("tracks the session status Linear derives from the activity, without a second mutation", async () => {
    const client = fakeSessionClient();
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });
    await bridge.begin(ISSUE);

    await bridge.publish(renderLifecycleEvent(baseEvent({ kind: "waiting-input", summary: "Need a decision" })));

    expect(bridge.snapshot().status).toBe(SESSION_STATUS.awaitingInput);
  });

  it("queues a transient failure and flushes it on a later pass", async () => {
    const client = fakeSessionClient({ activityError: new Error("fetch failed") });
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });
    await bridge.begin(ISSUE);

    const failed = await bridge.publish(renderLifecycleEvent(baseEvent()));
    expect(failed).toMatchObject({ published: false, queued: true });
    expect(bridge.snapshot().pending).toHaveLength(1);

    client.createAgentActivity = vi.fn(async function ({ agentSessionId, content }) {
      this.activities.push({ agentSessionId, content });
      return true;
    });
    expect(await bridge.flushPending()).toEqual({ flushed: 1, remaining: 0 });
    expect(bridge.snapshot().pending).toHaveLength(0);
  });

  it("does not queue the same activity twice, and bounds the queue", async () => {
    const client = fakeSessionClient({ activityError: new Error("fetch failed") });
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });
    await bridge.begin(ISSUE);

    const rendered = renderLifecycleEvent(baseEvent());
    await bridge.publish(rendered);
    await bridge.publish(rendered);
    expect(bridge.pending).toHaveLength(1);

    for (let i = 0; i < MAX_PENDING_ACTIVITIES + 10; i += 1) {
      await bridge.publish(renderLifecycleEvent(baseEvent({ kind: "progress", summary: `step ${i}`, action: "step" })));
    }
    expect(bridge.pending.length).toBeLessThanOrEqual(MAX_PENDING_ACTIVITIES);
  });

  it("records a failed recovery on a stale session so the next attempt opens a new linked one", async () => {
    const client = fakeSessionClient({ activityError: new Error("fetch failed") });
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });
    await bridge.begin(ISSUE, {
      existing: {
        id: "session-prior",
        status: "active",
        attempt: 1,
        lastActivityAt: new Date(Date.now() - STALE_SESSION_MS - 1000).toISOString(),
      },
    });

    await bridge.publish(renderLifecycleEvent(baseEvent()));
    const snapshot = bridge.snapshot();

    expect(snapshot.recoveryFailed).toBe(true);
    expect(resolveSessionForAttempt(snapshot)).toMatchObject({ action: "create", previousSessionId: "session-prior" });
  });

  it("falls back permanently, without queueing, when an activity is rejected for lack of entitlement", async () => {
    const client = fakeSessionClient({ activityError: new Error("agent sessions disabled") });
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });
    await bridge.begin(ISSUE);

    const result = await bridge.publish(renderLifecycleEvent(baseEvent()));

    expect(result.published).toBe(false);
    expect(result.queued).toBeUndefined();
    expect(bridge.mode).toBe("disabled");
    expect(bridge.pending).toHaveLength(0);
  });

  it("round-trips its snapshot through JSON, since it is persisted on the worktree registry entry", async () => {
    const client = fakeSessionClient();
    const bridge = new AgentSessionBridge({ linearClient: client, enabled: true });
    await bridge.begin(ISSUE);
    await bridge.publish(renderLifecycleEvent(baseEvent()));

    const restored = JSON.parse(JSON.stringify(bridge.snapshot()));

    expect(restored.id).toBe("session-1");
    expect(typeof restored.lastActivityAt).toBe("string");
    expect(resolveSessionForAttempt(restored).action).toBe("attach");
  });
});
