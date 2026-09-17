import { describe, it, expect, vi } from "vitest";
import { AGENT_SESSION_WEBHOOK_TYPE, SignalLedger, StopController } from "../src/agent-signals.mjs";
import { AgentStreamClient, parseSseFrames, DEFAULT_RETENTION_MS } from "../src/agent-stream-client.mjs";

function stopPayload(overrides = {}) {
  return {
    type: AGENT_SESSION_WEBHOOK_TYPE,
    action: "stop",
    webhookId: "wh-1",
    agentSession: { id: "session-1", issue: { id: "uuid-1", identifier: "MOV-158" } },
    agentActivity: { id: "activity-1" },
    ...overrides,
  };
}

function promptPayload(overrides = {}) {
  return {
    type: AGENT_SESSION_WEBHOOK_TYPE,
    action: "prompted",
    webhookId: "wh-2",
    agentSession: { id: "session-1", issue: { id: "uuid-1", identifier: "MOV-158" } },
    agentActivity: { id: "activity-2", content: { type: "prompt", body: "also update the docs" } },
    actor: { id: "user-1", name: "Adam", type: "user" },
    ...overrides,
  };
}

function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function frame(payload, receivedAt = Date.now()) {
  return { receivedAt, payload };
}

function fakeEntry(overrides = {}) {
  return {
    identifier: "MOV-158",
    controller: new StopController(),
    publisher: { publish: vi.fn().mockResolvedValue({ surface: "comment" }) },
    ...overrides,
  };
}

describe("parseSseFrames", () => {
  it("splits complete frames and keeps a trailing partial one as remainder", () => {
    const { frames, remainder } = parseSseFrames(`${sseFrame({ a: 1 })}${sseFrame({ b: 2 })}data: {"c"`);
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(remainder).toBe('data: {"c"');
  });

  it("ignores heartbeat comment lines", () => {
    const { frames } = parseSseFrames(`:heartbeat\n\n${sseFrame({ a: 1 })}`);
    expect(frames).toEqual([{ a: 1 }]);
  });

  it("drops a malformed frame instead of throwing", () => {
    expect(() => parseSseFrames(`data: not-json\n\n${sseFrame({ ok: true })}`)).not.toThrow();
    const { frames } = parseSseFrames(`data: not-json\n\n${sseFrame({ ok: true })}`);
    expect(frames).toEqual([{ ok: true }]);
  });
});

describe("AgentStreamClient.isConfigured", () => {
  it("requires both a stream URL and a credential", () => {
    expect(AgentStreamClient.isConfigured({ streamUrl: "https://x", streamCredential: "y" })).toBe(true);
    expect(AgentStreamClient.isConfigured({ streamUrl: "https://x" })).toBe(false);
    expect(AgentStreamClient.isConfigured({})).toBe(false);
  });
});

describe("AgentStreamClient#_handleFrame — routing and retention", () => {
  it("delivers a stop signal to the registered controller", () => {
    const entry = fakeEntry();
    const client = new AgentStreamClient({
      streamUrl: "https://x",
      streamCredential: "y",
      getActiveAttempt: () => entry,
    });
    client._handleFrame(frame(stopPayload()));
    expect(entry.controller.stopped).toBe(true);
  });

  it("drops a frame past the 10-minute retention ceiling without processing it", () => {
    const entry = fakeEntry();
    const client = new AgentStreamClient({ streamUrl: "https://x", streamCredential: "y", getActiveAttempt: () => entry });
    const stale = frame(stopPayload(), Date.now() - (DEFAULT_RETENTION_MS + 1000));
    client._handleFrame(stale);
    expect(entry.controller.stopped).toBe(false);
  });

  it("dedupes the same delivery across two separate frames (simulated reconnect replay)", () => {
    const entry = fakeEntry();
    const ledger = new SignalLedger();
    const client = new AgentStreamClient({ streamUrl: "https://x", streamCredential: "y", getActiveAttempt: () => entry, ledger });
    const p = stopPayload();
    const first = client._handleFrame(frame(p));
    const second = client._handleFrame(frame(p));
    expect(first.replay).toBeFalsy();
    expect(second.replay).toBe(true);
  });

  it("queues a trusted prompt for a live worker's next turn, and records it", () => {
    const queuePrompt = vi.fn();
    const entry = fakeEntry({ queuePrompt });
    const client = new AgentStreamClient({ streamUrl: "https://x", streamCredential: "y", getActiveAttempt: () => entry });
    client._handleFrame(frame(promptPayload()));
    expect(queuePrompt).toHaveBeenCalledWith("also update the docs");
    expect(entry.publisher.publish).toHaveBeenCalledWith(
      "prompt-received",
      expect.objectContaining({ summary: expect.stringContaining("Queued") }),
    );
  });

  it("records a trusted prompt as prompt-received when no queuePrompt is available", () => {
    const entry = fakeEntry(); // no queuePrompt -- not a steering-capable attempt
    const client = new AgentStreamClient({ streamUrl: "https://x", streamCredential: "y", getActiveAttempt: () => entry });
    client._handleFrame(frame(promptPayload()));
    expect(entry.publisher.publish).toHaveBeenCalledWith(
      "prompt-received",
      expect.objectContaining({ summary: expect.stringContaining("recorded only") }),
    );
  });

  it("drops a trusted prompt silently when no attempt is registered for the issue", () => {
    const client = new AgentStreamClient({ streamUrl: "https://x", streamCredential: "y", getActiveAttempt: () => null });
    expect(() => client._handleFrame(frame(promptPayload()))).not.toThrow();
  });

  it("never calls queuePrompt or the publisher for an untrusted prompt (adversarial: this dispatcher's own actor)", () => {
    const queuePrompt = vi.fn();
    const entry = fakeEntry({ queuePrompt });
    const client = new AgentStreamClient({
      streamUrl: "https://x",
      streamCredential: "y",
      getActiveAttempt: () => entry,
      trust: { selfActorIds: ["user-1"] },
    });
    client._handleFrame(frame(promptPayload()));
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(entry.publisher.publish).not.toHaveBeenCalled();
  });
});

/** A Response-shaped fake whose body is a real ReadableStream the test controls. */
function fakeStreamResponse({ status = 200, chunks = [] } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { status, ok: status >= 200 && status < 300, body };
}

// A real (tiny) timer tick, regardless of the requested delay -- this keeps
// the reconnect loop from spinning unboundedly fast in a test (which
// previously exhausted the heap), while staying fast to run. The *requested*
// delay is still recorded and asserted on separately.
function fastTick() {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

describe("AgentStreamClient — connection lifecycle", () => {
  it("reads frames from a real stream and processes them", async () => {
    const entry = fakeEntry();
    const fetchImpl = vi.fn().mockImplementation(async () =>
      fakeStreamResponse({ chunks: [sseFrame({ receivedAt: Date.now(), payload: stopPayload() })] }),
    );
    const client = new AgentStreamClient({
      streamUrl: "https://x",
      streamCredential: "y",
      fetchImpl,
      getActiveAttempt: () => entry,
      logger: { error: () => {} },
      sleepFn: fastTick,
    });
    client.start();
    await vi.waitFor(() => expect(entry.controller.stopped).toBe(true));
    await client.stop();
    expect(fetchImpl).toHaveBeenCalledWith("https://x", expect.objectContaining({ headers: { Authorization: "Bearer y" } }));
  });

  it("treats a 401 as credential rejection and keeps retrying without throwing out of start()", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 401, ok: false, body: null });
    const sleepCalls = [];
    const client = new AgentStreamClient({
      streamUrl: "https://x",
      streamCredential: "wrong",
      fetchImpl,
      logger: { error: () => {} },
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
        await fastTick();
      },
    });
    client.start();
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2));
    await client.stop();
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("resets backoff after an established connection drops, instead of continuing to grow", async () => {
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call <= 2) return { status: 500, ok: false, body: null }; // never established
      if (call === 3) return fakeStreamResponse({ chunks: [] }); // established, then ends immediately
      return { status: 500, ok: false, body: null };
    });
    const sleepCalls = [];
    const client = new AgentStreamClient({
      streamUrl: "https://x",
      streamCredential: "y",
      fetchImpl,
      logger: { error: () => {} },
      minBackoffMs: 100,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
        await fastTick();
      },
    });
    client.start();
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(4));
    await client.stop();
    // Calls 1,2 never established -> growing backoff; call 3 established -> the
    // delay recorded right after it (index 2) resets toward minBackoffMs rather
    // than continuing to grow from calls 1-2's delay.
    expect(sleepCalls[2]).toBeLessThan(sleepCalls[1]);
  });
});
