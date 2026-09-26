// Redacted provider event streams for worker-usage tests (MOV-382).
//
// PROVENANCE: these follow the event shapes documented for `codex exec --json`
// (thread.started / turn.started / item.* / turn.completed with a `usage`
// object) and `claude -p --output-format stream-json` (assistant/user
// messages ending in one `result`). The authoring worker could not launch
// either CLI (its sandbox refuses provider processes), so they are NOT captures
// from a live run. IDs, paths, prompts and tool output are placeholders. The
// human smoke run in the MOV-382 manual verification must diff a real redacted
// stream against these shapes and replace them if the CLI differs.
export const jsonl = (events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

export const CODEX_THREAD_ID = "00000000-0000-0000-0000-000000000000";

/** One turn: input includes the cached portion; no reasoning/cost/cache-write counters. */
export const CODEX_SINGLE_TURN = jsonl([
  { type: "thread.started", thread_id: CODEX_THREAD_ID },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "[redacted]" } },
  { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm run verify'", aggregated_output: "", exit_code: null, status: "in_progress" } },
  { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm run verify'", aggregated_output: "[redacted]", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "[redacted]" } },
  { type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } },
]);

/** Two turns reporting the thread's running total (each snapshot includes the previous). */
export const CODEX_CUMULATIVE_TURNS = jsonl([
  { type: "thread.started", thread_id: CODEX_THREAD_ID },
  { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 40 } },
  { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: 2600, cached_input_tokens: 2100, output_tokens: 260, reasoning_output_tokens: 90 } },
]);

/** The same final snapshot delivered twice, e.g. a replayed terminal event. */
export const CODEX_REPEATED_EVENT = jsonl([
  { type: "thread.started", thread_id: CODEX_THREAD_ID },
  { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50 } },
  { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50 } },
]);

/** A counter that drops between events cannot be a running total: both segments must count. */
export const CODEX_INDEPENDENT_DELTAS = jsonl([
  { type: "thread.started", thread_id: CODEX_THREAD_ID },
  { type: "turn.completed", usage: { input_tokens: 900, cached_input_tokens: 300, output_tokens: 90 } },
  { type: "turn.completed", usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 30 } },
]);

/** Killed mid-turn: no usage event, and the last line is cut off. */
export const CODEX_TRUNCATED = jsonl([
  { type: "thread.started", thread_id: CODEX_THREAD_ID },
  { type: "turn.started" },
  { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", aggregated_output: "", status: "in_progress" } },
]) + '{"type":"item.comp';

export const CODEX_TURN_FAILED = jsonl([
  { type: "thread.started", thread_id: CODEX_THREAD_ID },
  { type: "turn.started" },
  { type: "turn.failed", error: { message: "[redacted]" } },
]);

export const CLAUDE_RESULT = {
  type: "result", subtype: "success", is_error: false, num_turns: 42, duration_ms: 1_080_000, total_cost_usd: 1.2,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 3_100_000, cache_creation_input_tokens: 40 },
  modelUsage: { "claude-sonnet-5": {} },
};
export const CLAUDE_STREAM = jsonl([
  { type: "system", subtype: "init", model: "claude-sonnet-5" },
  { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "[redacted]" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "four" }] } },
  CLAUDE_RESULT,
]);
