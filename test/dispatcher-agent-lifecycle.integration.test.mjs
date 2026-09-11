// Deterministic integration coverage for MOV-158: the dispatcher's run loop
// publishing a full attempt lifecycle into Linear, and the polling stop control
// halting one, driven through the **real** LinearClient against an in-memory
// fake of Linear's GraphQL API.
//
// The unit tests pin each piece in isolation. What this file is for is the
// join: that a real GraphQL document produced by linear-client.mjs, handed the
// shape Linear documents, leaves the issue in the state a human would read off
// it — the PR URL and the working/waiting/error/finished state, with no local
// log needed (acceptance criterion 2).
//
// No network, no credential, no live Agent Session. The fake below is the only
// "Linear" involved, and there is no listener anywhere: inbound signals are
// replayed as fixtures (see tools/dispatcher/test/agent-signals.test.mjs).

import { describe, it, expect, vi } from "vitest";
import { runOnce } from "../tools/dispatcher/src/run-loop.mjs";
import { LinearClient } from "../tools/dispatcher/src/linear-client.mjs";
import { AgentSessionBridge, createAgentSessionCapability } from "../tools/dispatcher/src/agent-session.mjs";

const DISPATCHER_DELEGATE = { id: "actor-dispatcher", name: "moviecal-dispatcher" };
const DELEGATE_NODE = { id: "actor-dispatcher", name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" };
const STATE_IDS = {
  blocked: "state-blocked",
  agentWorking: "state-agent-working",
  needsHumanDecision: "state-needs-human",
  inReview: "state-in-review",
};
const STATE_NAMES = {
  "state-blocked": "Blocked",
  "state-agent-working": "Agent Working",
  "state-needs-human": "Needs Human Decision",
  "state-in-review": "In Review",
};
const PR_URL = "https://github.com/PelvicSorcerer/moviecal/pull/357";

/**
 * A minimal in-memory Linear: enough of the GraphQL surface for one issue's
 * dispatcher lifecycle, including the Developer Preview Agent Session
 * mutations. `agentSessionsEnabled: false` reproduces MOV-141's live finding —
 * the exact `agent sessions disabled` error the real workspace returns.
 */
function fakeLinear({ agentSessionsEnabled = false } = {}) {
  const store = {
    issue: {
      id: "uuid-158",
      identifier: "MOV-158",
      title: "Integrate the local dispatcher with Linear",
      description: "Do the work.",
      url: "https://linear.app/moviecal/issue/MOV-158",
      project: null,
      delegate: DELEGATE_NODE,
      labels: ["execution:mac"],
      stateName: "Ready for Agent",
    },
    comments: [],
    activities: [],
    sessions: [],
    externalLinks: [],
    requests: [],
  };

  const issueNode = () => ({
    id: store.issue.id,
    identifier: store.issue.identifier,
    title: store.issue.title,
    description: store.issue.description,
    url: store.issue.url,
    project: store.issue.project,
    delegate: store.issue.delegate,
    labels: { nodes: store.issue.labels.map((name) => ({ name })) },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    state: { name: store.issue.stateName },
  });

  const fetchImpl = vi.fn(async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    store.requests.push(query.trim().split("\n")[1]?.trim() || query.trim());
    const reply = (data) => ({ status: 200, json: async () => ({ data }) });
    const fail = (message) => ({ status: 200, json: async () => ({ errors: [{ message }] }) });

    if (query.includes("commentCreate")) {
      store.comments.push(variables.body);
      return reply({ commentCreate: { success: true } });
    }
    if (query.includes("issueUpdate")) {
      store.issue.stateName = STATE_NAMES[variables.stateId] || variables.stateId;
      return reply({ issueUpdate: { success: true } });
    }
    if (query.includes("agentSessionCreateOnIssue")) {
      if (!agentSessionsEnabled) return fail("agent sessions disabled");
      const session = { id: `session-${store.sessions.length + 1}`, status: "active" };
      store.sessions.push(session);
      return reply({ agentSessionCreateOnIssue: { success: true, agentSession: session } });
    }
    if (query.includes("agentActivityCreate")) {
      if (!agentSessionsEnabled) return fail("agent sessions disabled");
      store.activities.push({ agentSessionId: variables.agentSessionId, content: variables.content });
      return reply({ agentActivityCreate: { success: true, agentActivity: { id: `a${store.activities.length}` } } });
    }
    if (query.includes("agentSessionUpdate")) {
      store.externalLinks.push({ id: variables.id, externalUrl: variables.externalUrl });
      return reply({ agentSessionUpdate: { success: true } });
    }
    if (query.includes("issue(id:")) {
      return reply({ issue: issueNode() });
    }
    throw new Error(`fakeLinear received an unexpected query: ${query}`);
  });

  return { store, client: new LinearClient({ apiKey: "fixture-key", fetchImpl }), fetchImpl };
}

/**
 * A worktree manager backed by a real in-memory registry, so the Agent Session
 * record genuinely round-trips the way it does through `worktrees.json` — that
 * persistence is the polling recovery path (acceptance criterion 7).
 */
function registryWorktreeManager() {
  const state = new Map();
  return {
    state,
    activeCount: () => [...state.values()].filter((e) => e.status === "active").length,
    isPathFree: (p) => ![...state.values()].some((e) => e.path === p),
    create(args) {
      const entry = { ...args, path: `/tmp/worktrees/${args.name}`, status: "active" };
      state.set(args.id, entry);
      return entry;
    },
    markStatus(id, status, extra = {}) {
      Object.assign(state.get(id), { status, ...extra });
    },
    setWorkerPid(id, pid) {
      state.get(id).workerPid = pid;
    },
    updateEntry(id, extra) {
      if (!state.has(id)) throw new Error(`no worktree record for ${id}`);
      Object.assign(state.get(id), extra);
    },
    loadState: () => Object.fromEntries(state),
  };
}

function buildCtx(linear, { agentSessionsEnabled = false, capability, worktreeManager, ...overrides } = {}) {
  const manager = worktreeManager || registryWorktreeManager();
  return {
    linearClient: linear.client,
    stateIds: STATE_IDS,
    worktreeManager: manager,
    dispatcherDelegate: DISPATCHER_DELEGATE,
    concurrencyLimit: 1,
    workerTimeoutMs: 60_000,
    iosRunnerOnline: true,
    secretPresent: () => true,
    worktreeRoot: "/tmp/worktrees",
    ghRepo: "PelvicSorcerer/moviecal",
    logRoot: "/tmp/logs",
    spawnWorkerFn: vi.fn(async () => ({ exitCode: 0, pid: 4242, logDir: "/tmp/logs/x" })),
    findPrForBranchFn: vi.fn(() => ({ number: 357, url: PR_URL, isDraft: true })),
    auditWorkerResultFn: vi.fn(() => ({ ok: true, violations: [] })),
    writeWorkerAuditFn: vi.fn(() => ({ path: "/tmp/logs/x/security-audit.json", sha256: "fixture-sha" })),
    publishWorkerResultFn: vi.fn(() => ({ number: 357, url: PR_URL, isDraft: true, headSha: "fixture-sha" })),
    uncommittedChangesFn: () => [],
    refreshIssueFn: (issue) => linear.client.issueSnapshot(issue.id),
    agentSessionBridgeFn: () =>
      new AgentSessionBridge({
        linearClient: linear.client,
        enabled: agentSessionsEnabled,
        capability: capability || createAgentSessionCapability(),
      }),
    readAgentSessionFn: (id) => manager.loadState()[id]?.agentSession || null,
    persistAgentSessionFn: (id, snapshot) => {
      try {
        manager.updateEntry(id, { agentSession: snapshot });
      } catch {
        /* no record */
      }
    },
    stopPollIntervalMs: 0,
    logger: { error: vi.fn() },
    ...overrides,
  };
}

function pollIssue(linear) {
  return [
    {
      id: linear.store.issue.id,
      identifier: linear.store.issue.identifier,
      title: linear.store.issue.title,
      description: linear.store.issue.description,
      url: linear.store.issue.url,
      project: null,
      delegate: linear.store.issue.delegate,
      labels: linear.store.issue.labels,
      blockedByIds: [],
    },
  ];
}

describe("dispatcher lifecycle publication into Linear (MOV-158)", () => {
  it("leaves the issue showing the PR URL and a finished state, readable without any local log", async () => {
    const linear = fakeLinear();
    const ctx = buildCtx(linear);

    const [result] = await runOnce(pollIssue(linear), ctx);

    expect(result.outcome).toBe("in-review");
    expect(linear.store.issue.stateName).toBe("In Review");
    // Acknowledgement first, with where the work is happening...
    expect(linear.store.comments[0]).toContain("**Dispatcher started work.**");
    expect(linear.store.comments[0]).toContain("agent/MOV-158-integrate-the-local-dispatcher-with-line");
    // ...and the PR link last, on the issue itself.
    expect(linear.store.comments.at(-1)).toContain(PR_URL);
  });

  it("acknowledges promptly even though Agent Sessions are disabled for this app (MOV-141)", async () => {
    const linear = fakeLinear({ agentSessionsEnabled: false });
    const ctx = buildCtx(linear, { agentSessionsEnabled: true });

    await runOnce(pollIssue(linear), ctx);

    // One doomed create attempt, then the complete comment surface — the
    // acknowledgement is not lost or delayed by the missing entitlement.
    expect(linear.store.sessions).toHaveLength(0);
    expect(linear.store.activities).toHaveLength(0);
    expect(linear.store.comments[0]).toContain("**Dispatcher started work.**");
    expect(linear.store.issue.stateName).toBe("In Review");
  });

  it("never retries the unsupported mutation once Linear has rejected it (acceptance criterion 6)", async () => {
    const linear = fakeLinear({ agentSessionsEnabled: false });
    const capability = createAgentSessionCapability();

    // Two full poll cycles against a shared process-wide latch.
    await runOnce(pollIssue(linear), buildCtx(linear, { agentSessionsEnabled: true, capability }));
    linear.store.issue.stateName = "Ready for Agent";
    await runOnce(pollIssue(linear), buildCtx(linear, { agentSessionsEnabled: true, capability }));

    const createAttempts = linear.store.requests.filter((q) => q.includes("agentSessionCreateOnIssue"));
    expect(createAttempts).toHaveLength(1);
    expect(capability.denied).toBe(true);
    // The fallback surface stayed complete across both cycles.
    expect(linear.store.comments.filter((c) => c.includes("Dispatcher started work"))).toHaveLength(2);
  });

  it("publishes first-class activities, and the PR as a session external link, when sessions work", async () => {
    const linear = fakeLinear({ agentSessionsEnabled: true });
    const ctx = buildCtx(linear, { agentSessionsEnabled: true });

    const [result] = await runOnce(pollIssue(linear), ctx);

    expect(result.outcome).toBe("in-review");
    expect(linear.store.sessions).toHaveLength(1);
    expect(linear.store.activities.map((a) => a.content.type)).toEqual(["thought", "action"]);
    expect(linear.store.externalLinks).toEqual([{ id: "session-1", externalUrl: PR_URL }]);
    // Presentation moved to the session; control state did not.
    expect(linear.store.comments).toEqual([]);
    expect(linear.store.issue.stateName).toBe("In Review");
  });

  it("recovers lifecycle state from the registry across a restart, with no webhook (criterion 7)", async () => {
    const linear = fakeLinear({ agentSessionsEnabled: true });
    const manager = registryWorktreeManager();

    await runOnce(pollIssue(linear), buildCtx(linear, { agentSessionsEnabled: true, worktreeManager: manager }));

    // What survives the process is the persisted record, not any in-memory state.
    const persisted = manager.loadState()["MOV-158"].agentSession;
    expect(persisted).toMatchObject({ id: "session-1", attempt: 1 });
    expect(JSON.parse(JSON.stringify(persisted)).lastActivityAt).toEqual(expect.any(String));

    // A fresh context reading that record attaches rather than opening a second
    // session for the same live work.
    const restarted = buildCtx(linear, { agentSessionsEnabled: true, worktreeManager: manager });
    const bridge = restarted.agentSessionBridgeFn();
    const begun = await bridge.begin(pollIssue(linear)[0], { existing: restarted.readAgentSessionFn("MOV-158") });

    expect(begun).toMatchObject({ mode: "session", sessionId: "session-1", attached: true });
    expect(linear.store.sessions).toHaveLength(1);
  });

  it("opens a new linked session for a repair attempt, keeping issue/branch/PR as the identity (criterion 5)", async () => {
    const linear = fakeLinear({ agentSessionsEnabled: true });
    const manager = registryWorktreeManager();
    await runOnce(pollIssue(linear), buildCtx(linear, { agentSessionsEnabled: true, worktreeManager: manager }));

    // The first attempt finished, so its session is terminal and cannot be
    // resumed — a CI repair must open a fresh, linked one.
    manager.updateEntry("MOV-158", {
      agentSession: { ...manager.loadState()["MOV-158"].agentSession, status: "complete" },
    });
    linear.store.issue.stateName = "Ready for Agent";
    manager.state.delete("MOV-158");
    manager.state.set("MOV-158-prior", {
      id: "MOV-158-prior",
      path: "/tmp/worktrees/other",
      status: "review",
      agentSession: { id: "session-1", status: "complete", attempt: 1 },
    });

    await runOnce(
      pollIssue(linear),
      buildCtx(linear, {
        agentSessionsEnabled: true,
        worktreeManager: manager,
        readAgentSessionFn: () => ({ id: "session-1", status: "complete", attempt: 1 }),
      }),
    );

    expect(linear.store.sessions.map((s) => s.id)).toEqual(["session-1", "session-2"]);
    const repairAck = linear.store.activities.find((a) => a.agentSessionId === "session-2");
    expect(repairAck.content.body).toContain("MOV-158");
    expect(repairAck.content.body).toContain("agent/MOV-158-integrate-the-local-dispatcher-with-line");
    expect(repairAck.content.body).toContain("attempt 2");
    expect(repairAck.content.body).toContain("continues session session-1");
  });
});

describe("polling stop behaviour in the run loop (MOV-158)", () => {
  /** Hold the worker open until the test releases it, so the stop poll can fire. */
  function heldWorker() {
    let release;
    const promise = new Promise((resolve) => {
      release = () => resolve({ exitCode: 0, pid: 4242, logDir: "/tmp/logs/x" });
    });
    let signal;
    const fn = vi.fn((args) => {
      signal = args.signal;
      return promise;
    });
    return { fn, release: () => release(), signalOf: () => signal };
  }

  it("makes no further writes after a de-delegation, and does not comment on an issue it no longer owns", async () => {
    const linear = fakeLinear();
    const worker = heldWorker();
    const ctx = buildCtx(linear, { spawnWorkerFn: worker.fn, stopPollIntervalMs: 1 });

    const run = runOnce(pollIssue(linear), ctx);
    // Let the claim land, then take the issue away mid-run.
    await new Promise((resolve) => setTimeout(resolve, 5));
    linear.store.issue.delegate = null;

    const [result] = await run;
    worker.release();

    expect(result.outcome).toBe("stopped");
    expect(result.reported).toBe(false);
    expect(worker.signalOf().aborted).toBe(true);
    // Only the pre-stop acknowledgement was ever written.
    expect(linear.store.comments).toHaveLength(1);
    expect(linear.store.comments[0]).toContain("Dispatcher started work");
    // The state is left exactly where the dispatcher last put it — a
    // de-delegated issue gets no further writes of any kind.
    expect(linear.store.issue.stateName).toBe("Agent Working");
    expect(ctx.findPrForBranchFn).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.loadState()["MOV-158"].status).toBe("abandoned");
  });

  it("records one explanation, and no state change, when cancelled while still delegated here", async () => {
    const linear = fakeLinear();
    const worker = heldWorker();
    const ctx = buildCtx(linear, { spawnWorkerFn: worker.fn, stopPollIntervalMs: 1 });

    const run = runOnce(pollIssue(linear), ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    linear.store.issue.stateName = "Canceled";

    const [result] = await run;
    worker.release();

    expect(result).toMatchObject({ outcome: "stopped", reported: true });
    expect(linear.store.comments).toHaveLength(2);
    expect(linear.store.comments.at(-1)).toContain("**Dispatcher stopped at a safe interruption boundary.**");
    // The human's chosen state is not overwritten.
    expect(linear.store.issue.stateName).toBe("Canceled");
  });

  it("runs to completion when nothing changes, however often it re-reads", async () => {
    const linear = fakeLinear();
    const worker = heldWorker();
    const ctx = buildCtx(linear, { spawnWorkerFn: worker.fn, stopPollIntervalMs: 1 });

    const run = runOnce(pollIssue(linear), ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    worker.release();
    const [result] = await run;

    expect(result.outcome).toBe("in-review");
    expect(linear.store.issue.stateName).toBe("In Review");
    expect(linear.store.comments.at(-1)).toContain(PR_URL);
  });
});
