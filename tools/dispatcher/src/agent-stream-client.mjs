// MOV-166: the Mac's outbound half of the Agent Session receiver.
//
// This is the *only* new inbound-signal transport this dispatcher gets: it
// makes one outbound, authenticated HTTP connection to the receiver (an SSE
// stream) and never listens for anything itself -- see
// docs/operators/local-execution.md §Security model and the structural guard
// in dispatcher-wiring.test.mjs that asserts no `.mjs` file under `src/`
// opens a server, socket, or port.
//
// Every frame that arrives is handed to `agent-signals.mjs`'s existing,
// unmodified `normalizeAgentSessionEvent()`/`handleAgentSignal()` -- this
// module's job is transport (connect, reconnect, retention, routing), not
// signal semantics. A `stop` signal reaching `handleAgentSignal()` with the
// right `StopController` is already sufficient (combined with that
// controller's wake signal) to interrupt a worker promptly; a trusted
// `prompted` signal is additionally queued here for a live worker's next turn
// (via `entry.queuePrompt`, when one is registered -- MOV-214/215; run-loop.mjs
// owns actually writing it), or recorded as a `prompt-received` lifecycle
// event otherwise.
//
// All I/O is injected, so this is unit-testable without a real receiver: a
// test supplies a fake `fetchImpl` returning a `Response`-shaped object whose
// `body` is a `ReadableStream` the test controls directly.

import { handleAgentSignal, normalizeAgentSessionEvent, SignalLedger } from "./agent-signals.mjs";
import { activeAttempt } from "./active-attempt-registry.mjs";

export const DEFAULT_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_MIN_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 310_000;

function text(value) {
  return String(value ?? "").trim();
}

/** Sleep that resolves early on abort, so shutdown never waits out a full backoff interval. */
function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Split a raw SSE byte stream into `{receivedAt, payload}` wire frames.
 * The receiver's own wire format (see `src/app/api/agent-session/route.ts`)
 * is one JSON object per `data:` line, always `{receivedAt, payload}` --
 * `receivedAt` is the receiver's own receipt timestamp (ms since epoch),
 * `payload` is the parsed, HMAC-verified Linear webhook body, forwarded
 * as-is so all semantic parsing stays in `agent-signals.mjs`.
 *
 * Lines starting with `:` are heartbeat comments and are ignored, exactly as
 * SSE specifies. Malformed frames are dropped, not thrown -- a receiver bug
 * or a stray non-JSON keepalive must never crash the reconnect loop.
 */
export function parseSseFrames(buffer) {
  const frames = [];
  const parts = buffer.split("\n\n");
  // The last part may be an incomplete frame still being received; the
  // caller keeps it and prepends it to the next chunk.
  const remainder = parts.pop() ?? "";
  for (const part of parts) {
    const dataLines = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) continue; // pure heartbeat/comment frame
    try {
      const parsed = JSON.parse(dataLines.join("\n"));
      if (parsed && typeof parsed === "object") frames.push(parsed);
    } catch {
      // Malformed frame: drop it silently. Retention/dedup downstream never
      // sees it, which is the correct outcome for un-parseable input.
    }
  }
  return { frames, remainder };
}

/**
 * @param {object} opts
 * @param {string} opts.streamUrl
 * @param {string} opts.streamCredential
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {import("./agent-signals.mjs").SignalLedger} [opts.ledger]
 * @param {(issueId: string) => object|null} [opts.getActiveAttempt] - injectable for tests; defaults to the shared registry
 * @param {object} [opts.trust] - options forwarded to classifyPromptTrust via handleAgentSignal
 * @param {() => number} [opts.now]
 * @param {number} [opts.retentionMs] - MOV-166's own 10-minute ceiling, enforced defensively here in addition to the receiver's own prune
 * @param {number} [opts.minBackoffMs]
 * @param {number} [opts.maxBackoffMs]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleepFn]
 * @param {{error: Function, log?: Function}} [opts.logger]
 */
export class AgentStreamClient {
  constructor({
    streamUrl,
    streamCredential,
    fetchImpl = fetch,
    ledger = new SignalLedger(),
    getActiveAttempt = activeAttempt,
    trust = {},
    now = () => Date.now(),
    retentionMs = DEFAULT_RETENTION_MS,
    minBackoffMs = DEFAULT_MIN_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
    sleepFn = abortableDelay,
    logger = console,
  } = {}) {
    this.streamUrl = streamUrl;
    this.streamCredential = streamCredential;
    this.fetchImpl = fetchImpl;
    this.ledger = ledger;
    this.getActiveAttempt = getActiveAttempt;
    this.trust = trust;
    this.now = now;
    this.retentionMs = retentionMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.sleepFn = sleepFn;
    this.logger = logger;
    this._abort = null;
    this._loopPromise = null;
  }

  /** True once `streamUrl`/`streamCredential` are both present -- callers skip construction entirely otherwise. */
  static isConfigured({ streamUrl, streamCredential } = {}) {
    if (!text(streamUrl) || !text(streamCredential)) return false;
    try {
      const url = new URL(streamUrl);
      return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
    } catch {
      return false;
    }
  }

  /** Begin the reconnect loop. Fire-and-forget by design: never awaited by the dispatcher's poll loop. */
  start() {
    if (this._abort) return; // already running
    this._abort = new AbortController();
    this._loopPromise = this._runLoop(this._abort.signal).catch((err) => {
      this.logger.error(`Agent Session stream loop exited unexpectedly (polling continues): ${err.message}`);
    });
  }

  /** Stop cleanly -- used by tests and by dispatcher shutdown. */
  async stop() {
    if (!this._abort) return;
    this._abort.abort();
    try {
      await this._loopPromise;
    } catch {
      // already logged in start()
    }
    this._abort = null;
    this._loopPromise = null;
  }

  async _runLoop(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      let established = false;
      try {
        established = await this._connectOnce(signal, () => {
          established = true;
        });
      } catch (err) {
        if (!signal.aborted) {
          this.logger.error(`Agent Session stream connection ${err.credentialRejected ? "was rejected" : "dropped"} (${err.message}); reconnecting`);
        }
      }
      if (signal.aborted) break;
      attempt = established ? 0 : attempt + 1;
      const delay = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** attempt) + Math.floor(Math.random() * this.minBackoffMs);
      await this.sleepFn(delay, signal);
    }
  }

  /**
   * One connection attempt: authenticate, read frames until the stream ends
   * or `signal` aborts. Returns/resolves normally on a clean end (the
   * connection was at least established); throws on a request-level failure
   * (network error, non-2xx status) so the caller can distinguish "we were
   * connected and it dropped" from "we never connected at all" for backoff
   * purposes. A `401`/`403` sets `err.credentialRejected = true`.
   */
  async _connectOnce(signal, onEstablished) {
    const timeout = AbortSignal.timeout(this.connectionTimeoutMs);
    const requestSignal = AbortSignal.any([signal, timeout]);
    const response = await this.fetchImpl(this.streamUrl, {
      headers: { Authorization: `Bearer ${this.streamCredential}` },
      signal: requestSignal,
    });
    if (response.status === 401 || response.status === 403) {
      const err = new Error(`stream credential rejected (HTTP ${response.status})`);
      err.credentialRejected = true;
      throw err;
    }
    if (!response.ok || !response.body) {
      throw new Error(`unexpected stream response (HTTP ${response.status})`);
    }
    onEstablished();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const { frames } = parseSseFrames(`${buffer}\n\n`);
          for (const frame of frames) this._handleFrame(frame);
          return true;
        }
        buffer += decoder.decode(value, { stream: true });
        const { frames, remainder } = parseSseFrames(buffer);
        buffer = remainder;
        for (const frame of frames) this._handleFrame(frame);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released by the stream ending
      }
    }
  }

  /** @param {{receivedAt?: number, payload?: object}} frame */
  _handleFrame(frame) {
    const { receivedAt, payload } = frame || {};
    if (typeof receivedAt === "number" && this.now() - receivedAt > this.retentionMs) {
      // MOV-166's own retention ceiling: dropped, not delivered late, even if
      // the receiver's own buffer prune somehow missed it.
      return { handled: false, reason: "past the 10-minute retention ceiling", replay: false, stopped: false, prompt: null };
    }
    if (!payload || typeof payload !== "object") {
      return { handled: false, reason: "frame carried no payload", replay: false, stopped: false, prompt: null };
    }

    const peek = normalizeAgentSessionEvent(payload, { now: this.now() });
    const entry = peek.ok ? this.getActiveAttempt(peek.issueId) : null;
    const result = handleAgentSignal(payload, {
      controller: entry ? entry.controller : null,
      ledger: this.ledger,
      trust: this.trust,
      now: this.now(),
    });

    if (result.kind === "prompted" && result.prompt && result.prompt.trusted) {
      this._deliverPrompt({ entry, result, actorName: peek.actor && peek.actor.name });
    }
    return result;
  }

  /**
   * Queue a trusted prompt for delivery to a live worker when this attempt is
   * steering-capable (`entry.queuePrompt` present), else record it as a
   * `prompt-received` lifecycle event. Never throws: delivery/publication
   * failures are logged and swallowed, matching every other non-fatal
   * lifecycle-publication path in this dispatcher.
   *
   * This only ever *queues* the prompt via `entry.queuePrompt` -- it never
   * writes to a worker process directly, and no attempt registers
   * `queuePrompt` today (steering is a separate, not-yet-built capability;
   * see MOV-214/MOV-215). Until it exists, every trusted prompt takes the
   * record-only path below.
   */
  _deliverPrompt({ entry, result, actorName }) {
    const who = actorName || "a workspace user";
    if (entry && typeof entry.queuePrompt === "function") {
      try {
        entry.queuePrompt(result.prompt.body);
        this._recordPrompt(
          entry,
          `Queued a follow-up prompt from ${who} for delivery to the running worker at its next turn.`,
          result.prompt.body,
        );
        return;
      } catch (err) {
        this.logger.error(`Could not queue a trusted prompt for the live worker for ${entry.identifier} (recording only): ${err.message}`);
        // fall through to record-only below
      }
    }
    if (entry) {
      this._recordPrompt(
        entry,
        `Received a follow-up prompt from ${who} -- no live delivery available for this attempt; recorded only.`,
        result.prompt.body,
      );
    }
    // No active attempt at all: nothing to record against. Drop silently --
    // the receiver is not authoritative for anything, and "no attempt
    // running" is a completely normal state.
  }

  _recordPrompt(entry, summary, detail) {
    if (!entry || !entry.publisher) return;
    Promise.resolve(entry.publisher.publish("prompt-received", { summary, detail })).catch((err) => {
      this.logger.error(`Could not record a trusted prompt for ${entry.identifier}: ${err.message}`);
    });
  }
}
