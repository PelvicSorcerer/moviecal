// Structured, redacted worker accounting. Only numeric counters and bounded
// identifiers leave the transcript; no commands, prompts, or tool output do.
import fs from "node:fs";
import path from "node:path";
import { JsonStateStore } from "./state-store.mjs";

const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : null;
const size = (value) => typeof value === "string" ? value.length : value == null ? 0 : JSON.stringify(value).length;

export function parseWorkerUsage(transcript, { issue, attemptKind, worker, modelId = null, tier = null, reasoningEffort = null, exitOutcome = null, durationMs = null } = {}) {
  const summary = {
    issue: identifier(issue), attemptKind: identifier(attemptKind), worker: identifier(worker),
    modelId: identifier(modelId), tier: identifier(tier), reasoningEffort: identifier(reasoningEffort),
    turns: null, durationMs: number(durationMs), costUsd: null,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, thinkingTokens: null,
    exitOutcome: identifier(exitOutcome), verifyRuns: 0, toolCalls: {}, toolResultChars: {}, partial: true,
  };
  let result = null;
  let codexUsage = null;
  const seenCommands = new Set();
  const toolNames = new Map();
  let malformed = false;
  for (const line of String(transcript || "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { malformed = true; continue; }
    if (!event || typeof event !== "object") continue;
    if (worker === "claude" && event.type === "result") result = event;
    if (worker === "codex" && (event.type === "turn.completed" || event.type === "thread.completed")) {
      codexUsage = event.usage || codexUsage;
      if (event.type === "turn.completed") summary.turns = (summary.turns || 0) + 1;
    }
    if (worker === "codex" && event.type === "thread.started") summary.modelId ||= identifier(event.model);

    const content = event.message?.content || event.content || [];
    for (const block of Array.isArray(content) ? content : [content]) {
      if (block?.type === "tool_use") {
        const name = identifier(block.name);
        if (!name) continue;
        summary.toolCalls[name] = (summary.toolCalls[name] || 0) + 1;
        if (block.id) toolNames.set(block.id, name);
        if (name === "Bash" && block.input?.command === "npm run verify") summary.verifyRuns += 1;
      } else if (block?.type === "tool_result") {
        const name = toolNames.get(block.tool_use_id);
        if (name) summary.toolResultChars[name] = (summary.toolResultChars[name] || 0) + size(block.content);
      }
    }
    const item = event.item;
    if (worker === "codex" && item && item.type !== "command_execution" && event.type === "item.completed") {
      const name = identifier(item.type);
      if (name) {
        summary.toolCalls[name] = (summary.toolCalls[name] || 0) + 1;
        const chars = size(item.output || item.result || item.aggregated_output);
        if (chars) summary.toolResultChars[name] = (summary.toolResultChars[name] || 0) + chars;
      }
    }
    if (worker === "codex" && item?.type === "command_execution") {
      const key = identifier(item.id) || `${summary.toolCalls.command_execution || 0}`;
      if (event.type === "item.started" && !seenCommands.has(key)) {
        seenCommands.add(key);
        summary.toolCalls.command_execution = (summary.toolCalls.command_execution || 0) + 1;
        if (item.command === "npm run verify") summary.verifyRuns += 1;
      }
      if (event.type === "item.completed") {
        if (!seenCommands.has(key)) {
          seenCommands.add(key);
          summary.toolCalls.command_execution = (summary.toolCalls.command_execution || 0) + 1;
          if (item.command === "npm run verify") summary.verifyRuns += 1;
        }
        summary.toolResultChars.command_execution = (summary.toolResultChars.command_execution || 0) + size(item.aggregated_output || item.output);
      }
    }
  }
  if (worker === "claude" && result) {
    summary.turns = number(result.num_turns);
    summary.durationMs = number(result.duration_ms);
    summary.costUsd = number(result.total_cost_usd);
    const usage = result.usage || {};
    summary.inputTokens = number(usage.input_tokens);
    summary.outputTokens = number(usage.output_tokens);
    summary.cacheReadTokens = number(usage.cache_read_input_tokens);
    summary.cacheWriteTokens = number(usage.cache_creation_input_tokens);
    summary.thinkingTokens = number(usage.thinking_tokens);
    const models = Object.keys(result.modelUsage || {});
    if (models.length === 1) summary.modelId = identifier(models[0]);
    summary.partial = malformed;
  } else if (worker === "codex" && codexUsage) {
    summary.inputTokens = number(codexUsage.input_tokens);
    summary.outputTokens = number(codexUsage.output_tokens);
    summary.cacheReadTokens = number(codexUsage.cached_input_tokens);
    summary.thinkingTokens = number(codexUsage.reasoning_output_tokens);
    summary.partial = true; // Codex does not report the full Claude result shape.
  }
  return summary;
}

export class WorkerUsageStore extends JsonStateStore {
  get label() { return "worker usage"; }
  record(summary) {
    this.update((state) => {
      if (!Array.isArray(state.runs)) state.runs = [];
      state.runs.push({ ...summary, recordedAt: new Date().toISOString() });
    });
  }
  recent() { return this.load().runs || []; }
}

export function captureWorkerUsage(logDir, context, { store = null, logger = console } = {}) {
  try {
    let transcript = "";
    try { transcript = fs.readFileSync(path.join(logDir, "stdout.log"), "utf8"); } catch { /* missing log is partial */ }
    let fallbackDurationMs = null;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8"));
      const duration = Date.parse(manifest.endedAt) - Date.parse(manifest.startedAt);
      if (Number.isFinite(duration) && duration >= 0) fallbackDurationMs = duration;
    } catch { /* incomplete attempt */ }
    const summary = parseWorkerUsage(transcript, { ...context, durationMs: fallbackDurationMs });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "usage.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    store?.record(summary);
    return summary;
  } catch (error) {
    logger.error(`Could not record worker usage for ${context.issue}: ${error.message}`);
    return null;
  }
}

export function formatUsageLine(usage) {
  if (!usage) return "Usage: unavailable.";
  const fields = [usage.modelId || usage.worker || "unknown model", `(${usage.tier || "unknown tier"})`];
  if (usage.turns != null) fields.push(`${usage.turns} turns`);
  if (usage.durationMs != null) fields.push(`${Math.round(usage.durationMs / 60000)}m`);
  if (usage.costUsd != null) fields.push(`~$${usage.costUsd.toFixed(2)}`);
  if (usage.cacheReadTokens != null) fields.push(`${(usage.cacheReadTokens / 1e6).toFixed(1)}M cache-read`);
  fields.push(`${usage.verifyRuns} verify runs`);
  return `Usage: ${fields.join(", ")}.`;
}

const median = (values) => {
  const sorted = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export function aggregateUsage(runs, key) {
  const groups = new Map();
  for (const run of runs) {
    const group = run[key] || "unknown";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(run);
  }
  const metrics = {
    costUsd: "costUsd", durationMs: "durationMs", turns: "turns",
    inputTokens: "inputTokens", outputTokens: "outputTokens",
    cacheReadTokens: "cacheReadTokens", cacheWriteTokens: "cacheWriteTokens",
    thinkingTokens: "thinkingTokens", verifyRuns: "verifyRuns",
  };
  return [...groups].map(([name, rows]) => {
    const report = { name, runs: rows.length };
    for (const [field, label] of Object.entries(metrics)) {
      const values = rows.map((row) => row[field]).filter((value) => typeof value === "number");
      report[`${label}Total`] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
      report[`${label}Median`] = median(values);
    }
    return report;
  }).sort((a, b) => a.name.localeCompare(b.name));
}
