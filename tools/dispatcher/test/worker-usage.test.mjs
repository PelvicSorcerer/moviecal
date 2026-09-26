import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateUsage, buildUsageExport, captureWorkerUsage, foldCodexUsage, parseUsageExportArgs, parseWorkerUsage,
  selectUsageRuns, unwrapShellCommand, usageCompleteness, usageContextFromInvocation, WorkerUsageStore,
} from "../src/worker-usage.mjs";
import {
  CLAUDE_STREAM, CODEX_CUMULATIVE_TURNS, CODEX_INDEPENDENT_DELTAS, CODEX_REPEATED_EVENT, CODEX_SINGLE_TURN,
  CODEX_TRUNCATED, CODEX_TURN_FAILED,
} from "./usage-fixtures.mjs";

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

  it("keeps Claude's reported cost apart from any estimate and labels turn units", () => {
    const result = parseWorkerUsage(CLAUDE_STREAM, { issue: "MOV-382", worker: "claude", modelId: "claude-sonnet-5", reasoningEffort: "high" });
    expect(result).toMatchObject({
      costUsd: 1.2, costSource: "claude-reported-api-equivalent", costEstimateUsd: null, turns: 42, turnsSource: "claude-result-num_turns",
      modelId: "claude-sonnet-5", modelSource: "provider-reported", reasoningEffort: "high", providerStatus: "success",
      tokenSemantics: { inputIncludesCacheRead: false }, usageEvents: 1,
    });
    expect(result.availability).toMatchObject({ costUsd: "reported", cacheWriteTokens: "reported", thinkingTokens: "not-exposed" });
    expect(result.availabilityNotes.thinkingTokens).toMatch(/thinking tokens/);
  });

  it("keeps the pinned model when Claude reports several models, and lists them", () => {
    const events = line({ type: "result", num_turns: 1, modelUsage: { "claude-sonnet-5": {}, "claude-haiku-4-5-20251001": {} } });
    const result = parseWorkerUsage(events, { worker: "claude", modelId: "claude-sonnet-5" });
    expect(result).toMatchObject({ modelId: "claude-sonnet-5", modelSource: "invocation", modelsReported: ["claude-sonnet-5", "claude-haiku-4-5-20251001"] });
  });

  it("keeps explicit nulls and partial true for a truncated Claude stream", () => {
    const result = parseWorkerUsage(claude.split("\n").slice(0, -1).join("\n") + "\n{", { issue: "MOV-363", worker: "claude" });
    expect(result).toMatchObject({ turns: null, costUsd: null, inputTokens: null, partial: true, verifyRuns: 2 });
    expect(result.availability).toMatchObject({ costUsd: "not-reported", inputTokens: "not-reported" });
  });

  it("retains a live observed turn count for a budget-reaped partial transcript", () => {
    const result = parseWorkerUsage('{"type":"assistant","message":{"role":"assistant"}}\n', {
      issue: "MOV-367", worker: "claude", attemptKind: "continuation", observedTurns: 8, exitOutcome: "exited-143", terminationReason: "turn-budget",
    });
    expect(result).toMatchObject({ turns: 8, turnsSource: "dispatcher-observed", partial: true, costUsd: null, exitOutcome: "exited-143", terminationReason: "turn-budget" });
  });

  describe("Claude startup check (MOV-386)", () => {
    const ALLOWED = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "NotebookEdit", "Task"];

    it("records a matching init event", () => {
      const events = [line({ type: "system", subtype: "init", permissionMode: "default", tools: ALLOWED, claude_code_version: "2.1.281" }), claude].join("\n");
      expect(parseWorkerUsage(events, { worker: "claude" }).startupCheck).toMatchObject({
        status: "match", permissionMode: "default", tools: ALLOWED, unexpectedTools: [], cliVersion: "2.1.281", problems: [],
      });
    });

    it("records an unexpected mode and every extra tool as a mismatch", () => {
      const events = [line({ type: "system", subtype: "init", permissionMode: "acceptEdits", tools: [...ALLOWED, "Workflow", "WebFetch"] }), claude].join("\n");
      const { startupCheck } = parseWorkerUsage(events, { worker: "claude" });
      expect(startupCheck).toMatchObject({ status: "mismatch", permissionMode: "acceptEdits", unexpectedTools: ["Workflow", "WebFetch"] });
      expect(startupCheck.problems.join(" ")).toMatch(/permissionMode is "acceptEdits", expected "default"/);
    });

    it("records a transcript with no init event as missing, and leaves Codex without a check", () => {
      expect(parseWorkerUsage(claude, { worker: "claude" }).startupCheck).toMatchObject({ status: "missing", permissionMode: null, tools: null });
      expect(parseWorkerUsage(CODEX_SINGLE_TURN, { worker: "codex" }).startupCheck).toBeNull();
    });
  });

  describe("Codex", () => {
    it("reports exactly what the CLI exposes and leaves the rest null with reasons", () => {
      const result = parseWorkerUsage(CODEX_SINGLE_TURN, { issue: "MOV-382", worker: "codex", modelId: "gpt-6-sol", reasoningEffort: "medium" });
      expect(result).toMatchObject({
        modelId: "gpt-6-sol", modelSource: "invocation", reasoningEffort: "medium", turns: 1, turnsSource: "codex-turn.completed-count",
        inputTokens: 24763, cacheReadTokens: 24448, outputTokens: 122,
        costUsd: null, cacheWriteTokens: null, thinkingTokens: null, costEstimateUsd: null,
        verifyRuns: 1, partial: false, usageEvents: 1, usageAggregation: "single-event", providerStatus: "completed",
        tokenSemantics: { inputIncludesCacheRead: true },
      });
      expect(result.availability).toMatchObject({ costUsd: "not-exposed", cacheWriteTokens: "not-exposed", thinkingTokens: "not-reported", inputTokens: "reported" });
      expect(result.availabilityNotes.costUsd).toMatch(/no cost/);
      expect(result.availabilityNotes.cacheWriteTokens).toMatch(/cache-write/);
    });

    it("keeps cached input inside the raw input counter instead of adding it again", () => {
      const result = parseWorkerUsage(CODEX_SINGLE_TURN, { worker: "codex" });
      expect(result.inputTokens).toBe(24763);
      expect(result.inputTokens + result.cacheReadTokens).not.toBe(result.inputTokens);
      expect(result.tokenSemantics.inputIncludesCacheRead).toBe(true);
    });

    it("treats successive turn usage as running totals: the last snapshot is the run, not their sum", () => {
      const result = parseWorkerUsage(CODEX_CUMULATIVE_TURNS, { worker: "codex" });
      expect(result).toMatchObject({ turns: 2, inputTokens: 2600, cacheReadTokens: 2100, outputTokens: 260, thinkingTokens: 90, usageEvents: 2, usageAggregation: "last-cumulative-snapshot" });
    });

    it("ignores a verbatim repeated usage event", () => {
      const result = parseWorkerUsage(CODEX_REPEATED_EVENT, { worker: "codex" });
      expect(result).toMatchObject({ inputTokens: 500, cacheReadTokens: 100, outputTokens: 50 });
    });

    it("banks the earlier segment when a counter drops, so independent deltas are not lost", () => {
      const result = parseWorkerUsage(CODEX_INDEPENDENT_DELTAS, { worker: "codex" });
      expect(result).toMatchObject({ inputTokens: 1300, cacheReadTokens: 400, outputTokens: 120, usageAggregation: "segmented-on-decrease" });
    });

    it("keeps a counter a later snapshot omits and a fields-only-later addition", () => {
      const folded = foldCodexUsage([{ input_tokens: 10, output_tokens: 1 }, { input_tokens: 20, reasoning_output_tokens: 5 }]);
      expect(folded.totals).toEqual({ inputTokens: 20, cacheReadTokens: null, outputTokens: 1, thinkingTokens: 5 });
    });

    it("leaves every counter null and the attempt partial for a truncated stream", () => {
      const result = parseWorkerUsage(CODEX_TRUNCATED, { issue: "MOV-382", worker: "codex", exitOutcome: "exited-143", terminationReason: "timeout" });
      expect(result).toMatchObject({ turns: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, thinkingTokens: null, usageEvents: 0, usageAggregation: null, partial: true, terminationReason: "timeout" });
      expect(result.availability).toMatchObject({ inputTokens: "not-reported", turns: "not-reported" });
      expect(parseWorkerUsage("", { worker: "codex" })).toMatchObject({ turns: null, inputTokens: null, costUsd: null, partial: true });
    });

    it("marks a failed turn partial with its provider status", () => {
      expect(parseWorkerUsage(CODEX_TURN_FAILED, { worker: "codex" })).toMatchObject({ partial: true, providerStatus: "failed", inputTokens: null });
    });

    it("counts a wrapped exact verify command once across started/completed events", () => {
      const wrapped = [
        { type: "item.started", item: { id: "one", type: "command_execution", command: "/bin/zsh -lc 'npm run verify'" } },
        { type: "item.completed", item: { id: "one", type: "command_execution", command: "/bin/zsh -lc 'npm run verify'", aggregated_output: "ok" } },
        { type: "item.started", item: { id: "two", type: "command_execution", command: "bash -lc \"npm run verify | tail\"" } },
      ].map(line).join("\n");
      expect(parseWorkerUsage(wrapped, { worker: "codex" })).toMatchObject({ verifyRuns: 1, toolCalls: { command_execution: 2 } });
      expect(unwrapShellCommand("bash -lc 'npm run verify'")).toBe("npm run verify");
      expect(unwrapShellCommand("npm run verify")).toBe("npm run verify");
    });
  });

  it("derives model and effort from the exact invocation for both workers", () => {
    expect(usageContextFromInvocation({ args: ["exec", "-c", "model_reasoning_effort=medium", "--model", "gpt-6-sol"] }, "codex")).toEqual({ modelId: "gpt-6-sol", reasoningEffort: "medium" });
    expect(usageContextFromInvocation({ args: ["-p", "--model", "claude-sonnet-5", "--effort", "high"] }, "claude")).toEqual({ modelId: "claude-sonnet-5", reasoningEffort: "high" });
    expect(usageContextFromInvocation({ args: ["-p"] }, "claude")).toEqual({ modelId: null, reasoningEffort: null });
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

  it("gives every capture a unique attempt id plus manifest timing, and never records one twice", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov382-capture-"));
    try {
      fs.writeFileSync(path.join(root, "stdout.log"), CODEX_SINGLE_TURN);
      fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ startedAt: "2026-09-25T10:00:00.000Z", endedAt: "2026-09-25T10:03:00.000Z", exitCode: 0 }));
      const store = new WorkerUsageStore(path.join(root, "state.json"));
      const context = { issue: "MOV-382", attemptKind: "implementation", worker: "codex", tier: "default", modelId: "gpt-6-sol", reasoningEffort: "medium" };
      const first = captureWorkerUsage(root, context, { store });
      const second = captureWorkerUsage(root, context, { store });
      expect(first.attemptId).not.toBe(second.attemptId);
      expect(first).toMatchObject({ startedAt: "2026-09-25T10:00:00.000Z", endedAt: "2026-09-25T10:03:00.000Z", wallDurationMs: 180_000, durationMs: 180_000, durationSource: "manifest-wall-clock", exitOutcome: "exited-0" });
      expect(store.recent()).toHaveLength(2);
      // The same attempt replayed into the ledger is ignored.
      expect(store.record({ ...first })).toBe(false);
      expect(store.recent()).toHaveLength(2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("usage export", () => {
  const base = { schemaVersion: 2, origin: "dispatcher", worker: "codex", tier: "default", modelId: "gpt-6-sol", exitOutcome: "exited-0", partial: false, tokenSemantics: { inputIncludesCacheRead: true } };
  const run = (overrides) => parseAndMerge(overrides);
  function parseAndMerge(overrides) {
    const parsed = parseWorkerUsage(overrides.transcript ?? CODEX_SINGLE_TURN, { worker: overrides.worker ?? "codex", issue: overrides.issue, attemptKind: overrides.attemptKind, attemptId: overrides.attemptId, origin: "dispatcher", startedAt: overrides.startedAt, wallDurationMs: 1000, exitOutcome: overrides.exitOutcome ?? "exited-0" });
    return { ...parsed, recordedAt: overrides.startedAt };
  }
  const ledger = [
    { issue: "MOV-1", worker: "claude", turns: 3, costUsd: 0.25, recordedAt: "2026-09-01T00:00:00.000Z" }, // legacy fixture-like row
    { ...base, issue: "MOV-1", attemptId: "fixture-with-no-origin", origin: null, recordedAt: "2026-09-25T09:00:00.000Z" },
    run({ issue: "MOV-382", attemptKind: "implementation", attemptId: "impl-1", startedAt: "2026-09-25T10:00:00.000Z" }),
    run({ issue: "MOV-382", attemptKind: "continuation", attemptId: "cont-1", startedAt: "2026-09-25T11:00:00.000Z", transcript: CODEX_TRUNCATED, exitOutcome: "exited-143" }),
    run({ issue: "MOV-382", attemptKind: "repair", attemptId: "repair-1", startedAt: "2026-09-25T12:00:00.000Z", transcript: CODEX_CUMULATIVE_TURNS }),
    run({ issue: "MOV-383", attemptKind: "implementation", attemptId: "other-1", startedAt: "2026-09-25T10:30:00.000Z", worker: "claude", transcript: CLAUDE_STREAM }),
  ];

  it("selects only dispatcher-attributed attempts for the requested issues and never legacy rows", () => {
    const { selected, excluded } = selectUsageRuns(ledger, { issues: ["MOV-382", "MOV-1"] });
    expect(selected.map((entry) => entry.attemptId)).toEqual(["impl-1", "cont-1", "repair-1"]);
    expect(excluded.legacyOrUnattributed).toBe(2);
    expect(selectUsageRuns(ledger, { issues: ["MOV-1"], includeLegacy: true }).selected).toHaveLength(2);
  });

  it("ANDs run ids and the time window with the issue filter", () => {
    expect(selectUsageRuns(ledger, { attemptIds: ["impl-1", "other-1"] }).selected.map((entry) => entry.attemptId)).toEqual(["impl-1", "other-1"]);
    expect(selectUsageRuns(ledger, { issues: ["MOV-382"], attemptIds: ["other-1"] }).selected).toEqual([]);
    const windowed = selectUsageRuns(ledger, { since: "2026-09-25T10:15:00.000Z", until: "2026-09-25T11:00:00.000Z" }).selected;
    expect(windowed.map((entry) => entry.attemptId)).toEqual(["other-1", "cont-1"]);
  });

  it("keeps failed and partial attempts, and sums an issue's attempts once each without mixing workers", () => {
    const report = buildUsageExport([...ledger, { ...ledger[2] }], { issues: ["MOV-382"] }, { now: () => new Date("2026-09-26T00:00:00Z") });
    expect(report).toMatchObject({ readOnly: true, generatedAt: "2026-09-26T00:00:00.000Z", selectedRuns: 3, totalRecords: 7, excluded: { duplicates: 1 }, unmatched: { issues: [], attemptIds: [] } });
    const [issue] = report.byIssue;
    expect(issue).toMatchObject({ issue: "MOV-382", attempts: 3, attemptIds: ["impl-1", "cont-1", "repair-1"], partialAttempts: 1 });
    expect(issue.attemptsByKind).toEqual({ implementation: 1, continuation: 1, repair: 1 });
    expect(issue.attemptsByExitOutcome).toEqual({ "exited-0": 2, "exited-143": 1 });
    const [codex] = issue.byWorker;
    expect(codex.worker).toBe("codex");
    // 24763 (impl) + missing (truncated continuation) + 2600 (repair)
    expect(codex.fields.inputTokens).toEqual({ sum: 27363, reported: 2, missing: 1 });
    expect(codex.fields.costUsd).toEqual({ sum: null, reported: 0, missing: 3 });
    expect(report.runs.map((entry) => entry.attemptId)).toEqual(["impl-1", "cont-1", "repair-1"]);
  });

  it("reports missing fields separately from zero, split by why they are missing", () => {
    const zero = { ...ledger[2], attemptId: "zero", outputTokens: 0, availability: { ...ledger[2].availability, outputTokens: "reported" } };
    const completeness = usageCompleteness([ledger[2], ledger[3], zero, { ...ledger[2], availability: undefined, costUsd: null }]);
    expect(completeness.inputTokens).toMatchObject({ runs: 4, reported: 3, missing: 1, missingNotReported: 1 });
    expect(completeness.outputTokens).toMatchObject({ reported: 3, zero: 1, missing: 1 });
    expect(completeness.costUsd).toMatchObject({ reported: 0, missing: 4, missingNotExposed: 3, missingUnknown: 1 });
    expect(completeness.cacheWriteTokens.missingNotExposed).toBe(3);
  });

  it("lists selectors that matched nothing", () => {
    const report = buildUsageExport(ledger, { issues: ["MOV-999"], attemptIds: ["nope"] });
    expect(report.selectedRuns).toBe(0);
    expect(report.unmatched).toEqual({ issues: ["MOV-999"], attemptIds: ["nope"] });
    expect(report.completeness.inputTokens).toMatchObject({ runs: 0, reported: 0, missing: 0 });
  });

  it("parses export flags and refuses an unselective or malformed request", () => {
    expect(parseUsageExportArgs(["--issue", "MOV-382", "--run", "impl-1", "--since", "2026-09-25T00:00:00Z", "--state", "/tmp/x.json", "--include-legacy"])).toEqual({
      filters: { issues: ["MOV-382"], attemptIds: ["impl-1"], since: "2026-09-25T00:00:00.000Z", until: null, includeLegacy: true }, statePath: "/tmp/x.json",
    });
    expect(() => parseUsageExportArgs([])).toThrow(/requires at least one/);
    expect(() => parseUsageExportArgs(["--include-legacy"])).toThrow(/requires at least one/);
    expect(() => parseUsageExportArgs(["--since", "yesterday-ish"])).toThrow(/not a valid date/);
    expect(() => parseUsageExportArgs(["--issue"])).toThrow(/requires a value/);
    expect(() => parseUsageExportArgs(["--issue", "bad id"])).toThrow(/valid identifier/);
    expect(() => parseUsageExportArgs(["--wat", "x"])).toThrow(/unknown option/);
  });
});
