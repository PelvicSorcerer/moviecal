import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  ACTIVE_WORK_STATES,
  AGENT_SESSION_WEBHOOK_TYPE,
  INTERRUPTION_BOUNDARIES,
  SignalLedger,
  StopController,
  abortableSleep,
  classifyPromptTrust,
  detectStopFromSnapshot,
  handleAgentSignal,
  normalizeAgentSessionEvent,
  stopRequestFromSignal,
  verifyWebhookSignature,
  watchForStop,
} from "../src/agent-signals.mjs";

const DELEGATE = { id: "actor-dispatcher", name: "moviecal-dispatcher" };

/** A Linear-shaped Agent Session delivery. Fixtures only — there is no receiver (MOV-141/159). */
function payload(overrides = {}) {
  return {
    type: AGENT_SESSION_WEBHOOK_TYPE,
    action: "prompted",
    webhookId: "wh-1",
    agentSession: { id: "session-1", issue: { id: "uuid-1", identifier: "MOV-158" } },
    agentActivity: { id: "activity-1", content: { type: "prompt", body: "please also update the docs" } },
    actor: { id: "user-1", name: "Adam", type: "user" },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    id: "uuid-1",
    identifier: "MOV-158",
    stateName: "Agent Working",
    labels: ["execution:mac"],
    delegate: { id: "actor-dispatcher", name: "moviecal-dispatcher", displayName: "moviecal-dispatcher" },
    ...overrides,
  };
}

describe("verifyWebhookSignature", () => {
  const secret = "fixture-secret-not-a-real-credential";
  const body = JSON.stringify({ hello: "world" });
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correctly signed raw body", () => {
    expect(verifyWebhookSignature(body, signature, secret)).toEqual({ ok: true, reason: null });
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhookSignature(`${body} `, signature, secret).ok).toBe(false);
  });

  it("fails closed when no secret is configured — which is the state today", () => {
    // No secret exists anywhere in this repo or its config, and MOV-168 adds
    // none. An unverifiable delivery is dropped, never trusted.
    expect(verifyWebhookSignature(body, signature, null)).toEqual({
      ok: false,
      reason: "no webhook secret configured",
    });
  });

  it("fails closed on a missing signature or body", () => {
    expect(verifyWebhookSignature(body, null, secret).ok).toBe(false);
    expect(verifyWebhookSignature(null, signature, secret).ok).toBe(false);
  });

  it("rejects a wrong-length signature without throwing", () => {
    expect(verifyWebhookSignature(body, "abc", secret)).toEqual({ ok: false, reason: "signature length mismatch" });
  });
});

describe("normalizeAgentSessionEvent", () => {
  it("normalizes a follow-up prompt", () => {
    const signal = normalizeAgentSessionEvent(payload());
    expect(signal).toMatchObject({
      ok: true,
      kind: "prompted",
      sessionId: "session-1",
      issueId: "uuid-1",
      issueIdentifier: "MOV-158",
      prompt: "please also update the docs",
    });
    expect(signal.actor).toMatchObject({ id: "user-1", name: "Adam", type: "user" });
  });

  it("recognizes a stop delivered as its own action", () => {
    expect(normalizeAgentSessionEvent(payload({ action: "stop" })).kind).toBe("stop");
    expect(normalizeAgentSessionEvent(payload({ action: "stopped" })).kind).toBe("stop");
  });

  it("recognizes a stop delivered as a signal on a prompted activity", () => {
    const signal = normalizeAgentSessionEvent(
      payload({ action: "prompted", agentActivity: { id: "activity-2", signal: "stop", content: { body: "halt" } } }),
    );
    expect(signal.kind).toBe("stop");
  });

  it("recognizes session creation", () => {
    expect(normalizeAgentSessionEvent(payload({ action: "created" })).kind).toBe("created");
  });

  it.each([
    [null, "payload is not an object"],
    ["not json", "payload is not an object"],
  ])("rejects a malformed payload (%s) without throwing", (input, reason) => {
    expect(normalizeAgentSessionEvent(input)).toMatchObject({ ok: false, reason });
  });

  it("rejects a payload of the wrong webhook type", () => {
    expect(normalizeAgentSessionEvent(payload({ type: "Issue" })).reason).toMatch(/unsupported webhook type/);
  });

  it("rejects a delivery that names no session", () => {
    expect(normalizeAgentSessionEvent(payload({ agentSession: null })).reason).toMatch(/names no agent session/);
  });

  it("rejects an unrecognized action rather than guessing what it meant", () => {
    expect(normalizeAgentSessionEvent(payload({ action: "vibed" })).reason).toMatch(/unsupported agent session action/);
  });

  it("rejects a stale delivery as a replay", () => {
    const now = Date.now();
    const result = normalizeAgentSessionEvent(payload({ webhookTimestamp: now - 300_000 }), { now });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/freshness window/);
  });

  it("accepts an undated delivery and leaves it to the idempotency ledger", () => {
    // Rejecting it would be a guess about Linear's payload shape, not a real
    // freshness signal.
    expect(normalizeAgentSessionEvent(payload()).ok).toBe(true);
  });

  it("keys two distinct prompts separately even under one retried webhookId", () => {
    const a = normalizeAgentSessionEvent(payload({ agentActivity: { id: "activity-1", content: { body: "a" } } }));
    const b = normalizeAgentSessionEvent(payload({ agentActivity: { id: "activity-2", content: { body: "b" } } }));
    expect(a.key).not.toBe(b.key);
  });

  it("gives a retried delivery of the same activity the same key", () => {
    expect(normalizeAgentSessionEvent(payload()).key).toBe(normalizeAgentSessionEvent(payload()).key);
  });
});

describe("SignalLedger", () => {
  it("records a key once", () => {
    const ledger = new SignalLedger();
    expect(ledger.record("k")).toBe(true);
    expect(ledger.record("k")).toBe(false);
    expect(ledger.has("k")).toBe(true);
  });

  it("ignores empty keys", () => {
    const ledger = new SignalLedger();
    expect(ledger.record("")).toBe(false);
    expect(ledger.has("")).toBe(false);
  });

  it("stays bounded, dropping the oldest entries", () => {
    const ledger = new SignalLedger({ max: 3 });
    for (const k of ["a", "b", "c", "d"]) ledger.record(k);
    expect(ledger.has("a")).toBe(false);
    expect(ledger.has("d")).toBe(true);
    expect(ledger.toJSON()).toEqual(["b", "c", "d"]);
  });

  it("round-trips through JSON so it can live with the rest of the durable state", () => {
    const ledger = new SignalLedger({ seen: ["a", "b"] });
    expect(new SignalLedger({ seen: JSON.parse(JSON.stringify(ledger)) }).has("a")).toBe(true);
  });
});

describe("classifyPromptTrust", () => {
  const prompted = () => normalizeAgentSessionEvent(payload());

  it("trusts a real workspace user by default", () => {
    expect(classifyPromptTrust(prompted())).toEqual({ trusted: true, reason: null });
  });

  it("never trusts a prompt from this dispatcher's own actor", () => {
    // An agent acting on its own emitted activity is a feedback loop, not a
    // follow-up.
    const verdict = classifyPromptTrust(prompted(), { selfActorNames: ["Adam"] });
    expect(verdict.trusted).toBe(false);
    expect(verdict.reason).toMatch(/own actor/);
  });

  it("matches the self-actor by id as well as name", () => {
    expect(classifyPromptTrust(prompted(), { selfActorIds: ["user-1"] }).trusted).toBe(false);
  });

  it("narrows to an allowlist when one is configured", () => {
    expect(classifyPromptTrust(prompted(), { trustedActorIds: ["user-1"] }).trusted).toBe(true);
    expect(classifyPromptTrust(prompted(), { trustedActorIds: ["someone-else"] }).trusted).toBe(false);
    expect(classifyPromptTrust(prompted(), { trustedActorNames: ["adam"] }).trusted).toBe(true);
  });

  it("does not trust a non-user actor without an explicit allowlist", () => {
    const signal = normalizeAgentSessionEvent(payload({ actor: { id: "app-1", name: "some-app", type: "app" } }));
    expect(classifyPromptTrust(signal).reason).toMatch(/app actor/);
  });

  it("refuses a prompt with no actor or no body", () => {
    expect(classifyPromptTrust(normalizeAgentSessionEvent(payload({ actor: null }))).reason).toMatch(/names no actor/);
    const empty = normalizeAgentSessionEvent(payload({ agentActivity: { id: "a", content: { body: "" } } }));
    expect(classifyPromptTrust(empty).reason).toMatch(/no body/);
  });

  it("refuses to treat a stop as a steering instruction", () => {
    const stop = normalizeAgentSessionEvent(payload({ action: "stop" }));
    expect(classifyPromptTrust(stop).trusted).toBe(false);
  });

  it("refuses an unusable signal", () => {
    expect(classifyPromptTrust({ ok: false })).toEqual({ trusted: false, reason: "signal was not usable" });
  });
});

describe("handleAgentSignal (the shared controller, acceptance criterion 4)", () => {
  it("routes a valid stop payload into the same StopController the polling path uses", () => {
    const controller = new StopController();
    const result = handleAgentSignal(payload({ action: "stop" }), { controller });

    expect(result).toMatchObject({ handled: true, kind: "stop", stopped: true, replay: false });
    expect(controller.stopped).toBe(true);
    expect(controller.stopRequest).toMatchObject({ source: "agent-session", mayWrite: true });
  });

  it("replays idempotently: a retried delivery changes nothing and still reads as stopped", () => {
    const controller = new StopController();
    const ledger = new SignalLedger();
    const onStop = vi.fn();
    controller.onStop = onStop;

    handleAgentSignal(payload({ action: "stop" }), { controller, ledger });
    const first = controller.stopRequest;
    const replay = handleAgentSignal(payload({ action: "stop" }), { controller, ledger });

    expect(replay).toMatchObject({ handled: false, replay: true, stopped: true });
    expect(controller.stopRequest).toBe(first);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("returns a trust verdict for a follow-up prompt without touching the controller", () => {
    const controller = new StopController();
    const result = handleAgentSignal(payload(), { controller });

    expect(result).toMatchObject({ handled: true, kind: "prompted", stopped: false });
    expect(result.prompt).toMatchObject({ trusted: true, body: "please also update the docs" });
    expect(controller.stopped).toBe(false);
  });

  it("reports an untrusted prompt as unhandled rather than acting on it", () => {
    const result = handleAgentSignal(payload(), { controller: new StopController(), trust: { selfActorIds: ["user-1"] } });
    expect(result.handled).toBe(false);
    expect(result.prompt.trusted).toBe(false);
  });

  it("reports a malformed payload without throwing", () => {
    expect(handleAgentSignal({ nope: true }, { controller: new StopController() })).toMatchObject({
      handled: false,
      kind: null,
    });
  });
});

describe("stopRequestFromSignal", () => {
  it("lets the dispatcher explain itself, because an explicit session stop leaves it the writer", () => {
    const request = stopRequestFromSignal(normalizeAgentSessionEvent(payload({ action: "stop" })));
    expect(request).toMatchObject({ source: "agent-session", mayWrite: true, sessionId: "session-1" });
  });

  it("returns null for anything that is not a stop", () => {
    expect(stopRequestFromSignal(normalizeAgentSessionEvent(payload()))).toBeNull();
    expect(stopRequestFromSignal(null)).toBeNull();
  });
});

describe("detectStopFromSnapshot (the stop control that works today)", () => {
  it("keeps going while the issue is still routed and delegated here", () => {
    expect(detectStopFromSnapshot(snapshot(), { expectedDelegate: DELEGATE })).toBeNull();
  });

  it("accepts both in-flight states, so the dispatcher's own transition is not read as a stop", () => {
    for (const stateName of ACTIVE_WORK_STATES) {
      expect(detectStopFromSnapshot(snapshot({ stateName }), { expectedDelegate: DELEGATE }), stateName).toBeNull();
    }
  });

  it("stops silently when the delegation was removed — this dispatcher is no longer the writer", () => {
    const stop = detectStopFromSnapshot(snapshot({ delegate: null }), { expectedDelegate: DELEGATE });
    expect(stop).toMatchObject({ source: "polling", mayWrite: false });
  });

  it("stops when the issue is canceled, and may still explain itself (still delegated here)", () => {
    const stop = detectStopFromSnapshot(snapshot({ stateName: "Canceled" }), { expectedDelegate: DELEGATE });
    expect(stop).toMatchObject({ mayWrite: true });
    expect(stop.reason).toMatch(/Canceled/);
  });

  it("stops when a human moves the issue to a state this dispatcher does not work under", () => {
    const stop = detectStopFromSnapshot(snapshot({ stateName: "Needs Human Decision" }), { expectedDelegate: DELEGATE });
    expect(stop).not.toBeNull();
    expect(stop.reason).toMatch(/Needs Human Decision/);
  });

  it("stops when the route changes to another adapter", () => {
    const stop = detectStopFromSnapshot(snapshot({ labels: ["execution:cloud"] }), { expectedDelegate: DELEGATE });
    expect(stop).not.toBeNull();
    expect(stop.reason).toMatch(/execution:cloud/);
  });

  it("stops silently when the issue is no longer readable at all", () => {
    expect(detectStopFromSnapshot(null, { expectedDelegate: DELEGATE })).toMatchObject({ mayWrite: false });
  });
});

describe("StopController", () => {
  it("keeps only the first request, so a repeated observation is idempotent", () => {
    const onStop = vi.fn();
    const controller = new StopController({ onStop });

    const first = controller.request({ source: "polling", reason: "de-delegated" });
    const second = controller.request({ source: "agent-session", reason: "stop signal" });

    expect(second).toBe(first);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("ignores a null request", () => {
    const controller = new StopController();
    expect(controller.request(null)).toBeNull();
    expect(controller.stopped).toBe(false);
  });

  it("defaults mayWrite to true, so an explicit stop can be explained", () => {
    const controller = new StopController();
    expect(controller.request({ source: "agent-session", reason: "stop" }).mayWrite).toBe(true);
  });

  it("records the stop even when an onStop listener throws", () => {
    const controller = new StopController({
      onStop: () => {
        throw new Error("listener exploded");
      },
    });
    expect(() => controller.request({ source: "polling", reason: "r" })).not.toThrow();
    expect(controller.stopped).toBe(true);
  });

  it("halts only at declared boundaries, and only once a stop exists", () => {
    const controller = new StopController();
    for (const boundary of INTERRUPTION_BOUNDARIES) {
      expect(controller.checkpoint(boundary).halt, boundary).toBe(false);
    }
    controller.request({ source: "polling", reason: "de-delegated" });
    for (const boundary of INTERRUPTION_BOUNDARIES) {
      expect(controller.checkpoint(boundary).halt, boundary).toBe(true);
    }
    expect(controller.boundariesChecked).toHaveLength(INTERRUPTION_BOUNDARIES.length * 2);
  });

  it("refuses an undeclared boundary, so a typo cannot silently skip a stop check", () => {
    expect(() => new StopController().checkpoint("whenever")).toThrow(/unknown interruption boundary/);
  });
});

describe("watchForStop", () => {
  const immediateSleep = () => Promise.resolve();

  it("is a no-op when the watcher is disabled", async () => {
    const observeStopFn = vi.fn();
    expect(await watchForStop({ controller: new StopController(), observeStopFn, intervalMs: 0 })).toBeNull();
    expect(observeStopFn).not.toHaveBeenCalled();
  });

  it("records the first observed stop and returns it", async () => {
    const controller = new StopController();
    const observeStopFn = vi.fn(async () => ({ source: "polling", reason: "de-delegated", mayWrite: false }));

    const request = await watchForStop({ controller, observeStopFn, intervalMs: 1, sleepFn: immediateSleep });

    expect(request).toMatchObject({ source: "polling", reason: "de-delegated" });
    expect(controller.stopped).toBe(true);
  });

  it("fails open: an observer that throws is retried, never read as a stop", async () => {
    const controller = new StopController();
    let calls = 0;
    const observeStopFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("Linear API error: 503");
      return { source: "polling", reason: "canceled", mayWrite: true };
    });

    const request = await watchForStop({ controller, observeStopFn, intervalMs: 1, sleepFn: immediateSleep });

    expect(calls).toBe(3);
    expect(request.reason).toBe("canceled");
  });

  it("stops watching when the worker settles", async () => {
    const controller = new StopController();
    const abort = new AbortController();
    const observeStopFn = vi.fn(async () => {
      abort.abort();
      return null;
    });

    const request = await watchForStop({
      controller,
      observeStopFn,
      intervalMs: 1,
      signal: abort.signal,
      sleepFn: immediateSleep,
    });

    expect(request).toBeNull();
    expect(observeStopFn).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the controller is already stopped", async () => {
    const controller = new StopController();
    controller.request({ source: "agent-session", reason: "stop signal" });
    const observeStopFn = vi.fn();

    const request = await watchForStop({ controller, observeStopFn, intervalMs: 1, sleepFn: immediateSleep });

    expect(observeStopFn).not.toHaveBeenCalled();
    expect(request.reason).toBe("stop signal");
  });
});

describe("abortableSleep", () => {
  it("resolves immediately when the signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(abortableSleep(60_000, abort.signal)).resolves.toBeUndefined();
  });

  it("resolves early when the signal aborts, leaving no dangling timer", async () => {
    const abort = new AbortController();
    const sleeping = abortableSleep(60_000, abort.signal);
    abort.abort();
    await expect(sleeping).resolves.toBeUndefined();
  });

  it("resolves on its own when the timer wins", async () => {
    await expect(abortableSleep(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});
