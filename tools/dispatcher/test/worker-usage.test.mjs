import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aggregateUsage, captureWorkerUsage, parseWorkerUsage, WorkerUsageStore } from "../src/worker-usage.mjs";

const line = (value) => JSON.stringify(value);
const claude = [
  { type: "assistant", message: { content: [{ type: "text", text: "Please run npm run verify" }, { type: "tool_use", id: "a", name: "Read", input: { file_path: "private" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "four" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "npm run verify" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: "npm run verify" } }] } },
  { type: "result", num_turns: 42, duration_ms: 1_080_000, total_cost_usd: 1.2, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 3_100_000, cache_creation_input_tokens: 40 }, modelUsage: { "claude-sonnet-5": {} } },
].map(line).join("\n");

describe("worker usage", () => {
  it("reads Claude's result verbatim and counts only structured exact commands", () => {
    const result = parseWorkerUsage(claude, { issue: "MOV-363", attemptKind: "implementation", worker: "claude", tier: "default", exitOutcome: "exited-0" });
    expect(result).toMatchObject({ modelId: "claude-sonnet-5", turns: 42, durationMs: 1_080_000, costUsd: 1.2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 3_100_000, cacheWriteTokens: 40, thinkingTokens: null, verifyRuns: 2, toolCalls: { Read: 1, Bash: 2 }, toolResultChars: { Read: 4 }, partial: false });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("keeps explicit nulls and partial true for a truncated Claude stream", () => {
    const result = parseWorkerUsage(claude.split("\n").slice(0, -1).join("\n") + "\n{", { issue: "MOV-363", worker: "claude" });
    expect(result).toMatchObject({ turns: null, costUsd: null, inputTokens: null, partial: true, verifyRuns: 2 });
  });

  it("retains a live observed turn count for a budget-reaped partial transcript", () => {
    const result = parseWorkerUsage('{"type":"assistant","message":{"role":"assistant"}}\n', {
      issue: "MOV-367", worker: "claude", attemptKind: "continuation", observedTurns: 8, exitOutcome: "exited-143",
    });
    expect(result).toMatchObject({ turns: 8, partial: true, costUsd: null, exitOutcome: "exited-143" });
  });

  it("uses available Codex usage, leaving absent values null", () => {
    const transcript = [
      { type: "item.started", item: { id: "one", type: "command_execution", command: "npm run verify" } },
      { type: "item.completed", item: { id: "one", type: "command_execution", command: "npm run verify", aggregated_output: "ok" } },
      { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 20, cached_input_tokens: 10 } },
    ].map(line).join("\n");
    expect(parseWorkerUsage(transcript, { worker: "codex" })).toMatchObject({ turns: 1, inputTokens: 50, outputTokens: 20, cacheReadTokens: 10, costUsd: null, verifyRuns: 1, partial: true });
    expect(parseWorkerUsage("", { worker: "codex" })).toMatchObject({ turns: null, inputTokens: null, costUsd: null, partial: true });
  });

  it("writes a redacted usage file and durable store, then aggregates medians and totals", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov363-usage-"));
    try {
      fs.writeFileSync(path.join(root, "stdout.log"), claude);
      const store = new WorkerUsageStore(path.join(root, "state.json"));
      const summary = captureWorkerUsage(root, { issue: "MOV-363", attemptKind: "implementation", worker: "claude", tier: "default" }, { store });
      expect(JSON.parse(fs.readFileSync(path.join(root, "usage.json"), "utf8"))).toEqual(summary);
      expect(store.recent()).toHaveLength(1);
      const [aggregate] = aggregateUsage([summary, { ...summary, costUsd: 2.4 }], "tier");
      expect(aggregate).toMatchObject({ name: "default", runs: 2 });
      expect(aggregate.costUsdTotal).toBeCloseTo(3.6);
      expect(aggregate.costUsdMedian).toBeCloseTo(1.8);
      expect(aggregate.cacheReadTokensTotal).toBe(6_200_000);
      expect(aggregate.verifyRunsMedian).toBe(2);
      expect(fs.readFileSync(path.join(root, "usage.json"), "utf8")).not.toContain("private");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
