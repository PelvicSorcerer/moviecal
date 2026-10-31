// Bounded broker-event fixtures for routed-request tests (MOV-426).
//
// PROVENANCE: no live routing broker exists yet -- MOV-427/MOV-428 own the
// actual OpenRouter/Jev credential and provider wiring described in
// docs/planning/mov-422-jev-router-trial.md. These are NOT captures from a
// live call. They are synthetic events in the bounded contract fixed by
// tools/dispatcher/src/routed-request.mjs's header comment, used to prove
// the parser/reducer/export behavior ahead of any live credential or
// provider work. IDs, hashes and invoice IDs are placeholders.
export const jsonl = (events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

const start = (overrides) => ({
  type: "request.start", issue: "MOV-426", attemptId: "impl-1",
  routerArm: "hosted-openrouter-jev", policyHash: "sha256:aaaaaaaa",
  requestedModel: "anthropic/claude-sonnet-5", requestedEffort: "medium",
  ...overrides,
});

/** A streaming response: several chunks, then usage and a clean end. */
export const ROUTED_STREAMING_SUCCESS = jsonl([
  start({ requestId: "req-1", turn: 1 }),
  { type: "request.chunk", requestId: "req-1", resolvedModel: "anthropic/claude-sonnet-5", resolvedEffort: "medium", provider: "anthropic", streamed: true },
  { type: "request.chunk", requestId: "req-1", resolvedModel: "anthropic/claude-sonnet-5", resolvedEffort: "medium", provider: "anthropic", streamed: true },
  { type: "request.usage", requestId: "req-1", usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0 } },
  { type: "request.end", requestId: "req-1", latencyMs: 842, apiEquivalentUsd: 0.012, billedUsd: 0.0091, invoiceId: "or-gen-001", fallback: false, error: null },
]);

/** The hosted endpoint never reports a served model/effort/provider or a charge: every optional field stays null, not invented. */
export const ROUTED_MISSING_METADATA = jsonl([
  { type: "request.start", requestId: "req-2", issue: "MOV-426", attemptId: "impl-1", turn: 2 },
  { type: "request.usage", requestId: "req-2", usage: {} },
  { type: "request.end", requestId: "req-2", error: null },
]);

/** The router switches models mid-stream; the record keeps every observed model and flags the switch. */
export const ROUTED_MODEL_SWITCH = jsonl([
  start({ requestId: "req-3", turn: 3 }),
  { type: "request.chunk", requestId: "req-3", resolvedModel: "anthropic/claude-sonnet-5", provider: "anthropic", streamed: true },
  { type: "request.chunk", requestId: "req-3", resolvedModel: "openai/gpt-6-sol", provider: "openai", streamed: true },
  { type: "request.usage", requestId: "req-3", usage: { inputTokens: 500, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 50 } },
  { type: "request.end", requestId: "req-3", latencyMs: 600, apiEquivalentUsd: 0.008, billedUsd: 0.006, invoiceId: "or-gen-003", fallback: true, fallbackReason: "candidate-unavailable", error: null },
]);

export const ROUTED_CACHE_HIT = jsonl([
  start({ requestId: "req-4", turn: 4 }),
  { type: "request.chunk", requestId: "req-4", resolvedModel: "anthropic/claude-sonnet-5", provider: "anthropic", streamed: false },
  { type: "request.usage", requestId: "req-4", usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 3500, cacheWriteTokens: 0 } },
  { type: "request.end", requestId: "req-4", latencyMs: 300, apiEquivalentUsd: 0.005, billedUsd: 0.0004, invoiceId: "or-gen-004", fallback: false, error: null },
]);

export const ROUTED_CACHE_MISS = jsonl([
  start({ requestId: "req-5", turn: 5 }),
  { type: "request.chunk", requestId: "req-5", resolvedModel: "anthropic/claude-sonnet-5", provider: "anthropic", streamed: false },
  { type: "request.usage", requestId: "req-5", usage: { inputTokens: 4000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 4000 } },
  { type: "request.end", requestId: "req-5", latencyMs: 700, apiEquivalentUsd: 0.02, billedUsd: 0.018, invoiceId: "or-gen-005", fallback: false, error: null },
]);

/** A failed, still-billed first attempt, retried and accepted: one record, both invoice IDs, summed dollars. */
export const ROUTED_RETRY_THEN_SUCCESS = jsonl([
  start({ requestId: "req-6a", turn: 6 }),
  { type: "request.end", requestId: "req-6a", latencyMs: 250, billedUsd: 0.001, invoiceId: "or-gen-006a", fallback: false, error: "upstream-503" },
  start({ requestId: "req-6b", turn: 6, retryOf: "req-6a" }),
  { type: "request.chunk", requestId: "req-6b", resolvedModel: "anthropic/claude-sonnet-5", provider: "anthropic", streamed: true },
  { type: "request.usage", requestId: "req-6b", usage: { inputTokens: 900, outputTokens: 220, cacheReadTokens: 900, cacheWriteTokens: 0 } },
  { type: "request.end", requestId: "req-6b", latencyMs: 410, apiEquivalentUsd: 0.007, billedUsd: 0.005, invoiceId: "or-gen-006b", fallback: false, error: null },
]);

/** A malformed line and a truncated final event alongside one otherwise-valid request. */
export const ROUTED_MALFORMED = `not json at all\n${jsonl([
  start({ requestId: "req-7", turn: 7 }),
  { type: "request.usage", requestId: "req-7", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } },
])}{"type":"request.end","requestId":"req-7","truncat`;
