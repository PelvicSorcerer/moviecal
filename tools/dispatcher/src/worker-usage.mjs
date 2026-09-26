// Structured, redacted worker accounting. Only numeric counters and bounded
// identifiers leave the transcript; no commands, prompts, or tool output do.
//
// A missing value is never a zero: every numeric field is `null` unless the
// provider actually reported it, and `availability` says why it is null
// ("not-reported" for a truncated/absent event, "not-exposed" for a counter
// the provider CLI never emits). Counters keep the provider's own definition
// (Codex `input_tokens` includes `cached_input_tokens`; Claude's does not) and
// are never summed across harnesses.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { JsonStateStore } from "./state-store.mjs";

export const USAGE_SCHEMA_VERSION = 2;
/** Origin stamped by the live dispatcher wiring only; fixtures and tests never set it. */
export const DISPATCHER_ORIGIN = "dispatcher";

export const NUMERIC_FIELDS = [
  "turns", "durationMs", "wallDurationMs", "costUsd", "inputTokens", "outputTokens",
  "cacheReadTokens", "cacheWriteTokens", "thinkingTokens",
];

// Which counters each provider CLI can emit at all. Anything else is
// "not-exposed" rather than "not-reported" when null. Codex `thinkingTokens`
// (reasoning_output_tokens) is only present in newer CLI builds, so it is
// listed as exposable and reads "not-reported" when a stream lacks it.
const EXPOSED_FIELDS = {
  claude: ["turns", "durationMs", "wallDurationMs", "costUsd", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"],
  codex: ["turns", "durationMs", "wallDurationMs", "inputTokens", "outputTokens", "cacheReadTokens", "thinkingTokens"],
};
const NOT_EXPOSED_NOTES = {
  claude: { thinkingTokens: "Claude's result usage does not report thinking tokens separately." },
  codex: {
    costUsd: "Codex CLI JSON events expose no cost; none is derived.",
    cacheWriteTokens: "Codex CLI JSON events do not report cache-write tokens.",
  },
};
const TURN_SOURCES = {
  claude: "claude-result-num_turns",
  codex: "codex-turn.completed-count",
};

const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : null;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const size = (value) => typeof value === "string" ? value.length : value == null ? 0 : JSON.stringify(value).length;

/** Codex wraps commands as `bash -lc '<cmd>'`; unwrap so the exact-verify count sees the real command. */
export function unwrapShellCommand(command) {
  if (typeof command !== "string") return command;
  const match = /^(?:\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])(.*)\1$/s.exec(command.trim());
  return match ? match[2] : command;
}
const isVerify = (command) => unwrapShellCommand(command) === "npm run verify";

const CODEX_USAGE_FIELDS = {
  inputTokens: "input_tokens",
  cacheReadTokens: "cached_input_tokens",
  outputTokens: "output_tokens",
  thinkingTokens: "reasoning_output_tokens",
};

/**
 * Codex emits its usage on each `turn.completed`. Successive events are
 * treated as the thread's running total (cumulative snapshots): the latest one
 * is the run total and must not be summed with earlier ones. A counter that
 * goes *down* cannot be a cumulative snapshot, so that event starts a new
 * segment and the previous snapshot is banked instead of discarded. A verbatim
 * repeat is ignored. Fields absent from a later snapshot keep their last value.
 *
 * UNVERIFIED against a live CLI capture (the authoring worker could not launch
 * provider processes): if a real stream turns out to carry per-turn deltas that
 * only ever grow, this undercounts. `usageAggregation` records which rule
 * applied so the manual smoke run can confirm or falsify it.
 */
export function foldCodexUsage(events) {
  let current = null;
  let banked = {};
  let seen = 0;
  let segmented = false;
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const next = {};
    for (const field of Object.keys(CODEX_USAGE_FIELDS)) next[field] = number(raw[CODEX_USAGE_FIELDS[field]]);
    seen += 1;
    if (current) {
      if (Object.keys(next).every((field) => next[field] === current[field])) continue;
      if (Object.keys(next).some((field) => next[field] !== null && current[field] !== null && next[field] < current[field])) {
        for (const field of Object.keys(current)) if (current[field] !== null) banked[field] = (banked[field] || 0) + current[field];
        segmented = true;
        current = next;
        continue;
      }
      for (const field of Object.keys(next)) next[field] ??= current[field];
    }
    current = next;
  }
  const totals = {};
  for (const field of Object.keys(CODEX_USAGE_FIELDS)) {
    const values = [banked[field], current?.[field]].filter((value) => typeof value === "number");
    totals[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return { totals, events: seen, aggregation: seen === 0 ? null : segmented ? "segmented-on-decrease" : seen === 1 ? "single-event" : "last-cumulative-snapshot" };
}

export function parseWorkerUsage(transcript, {
  issue, attemptKind, worker, modelId = null, tier = null, reasoningEffort = null, exitOutcome = null,
  durationMs = null, observedTurns = null, attemptId = null, origin = null, startedAt = null, endedAt = null,
  wallDurationMs = null, terminationReason = null,
} = {}) {
  const wall = number(wallDurationMs) ?? number(durationMs);
  const summary = {
    schemaVersion: USAGE_SCHEMA_VERSION, attemptId: identifier(attemptId), origin: identifier(origin),
    issue: identifier(issue), attemptKind: identifier(attemptKind), worker: identifier(worker),
    modelId: identifier(modelId), modelSource: identifier(modelId) ? "invocation" : null, modelsReported: [],
    tier: identifier(tier), reasoningEffort: identifier(reasoningEffort),
    startedAt: timestamp(startedAt), endedAt: timestamp(endedAt),
    turns: null, turnsSource: null, durationMs: wall, wallDurationMs: wall, durationSource: wall === null ? null : "manifest-wall-clock",
    costUsd: null, costSource: null, costEstimateUsd: null,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, thinkingTokens: null,
    tokenSemantics: { inputIncludesCacheRead: worker === "codex" ? true : worker === "claude" ? false : null },
    usageEvents: 0, usageAggregation: null,
    exitOutcome: identifier(exitOutcome), terminationReason: identifier(terminationReason), providerStatus: null,
    verifyRuns: 0, toolCalls: {}, toolResultChars: {}, partial: true,
    availability: {}, availabilityNotes: {},
  };
  let result = null;
  const codexUsageEvents = [];
  let codexFailed = false;
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
      if (event.usage && typeof event.usage === "object") codexUsageEvents.push(event.usage);
      if (event.type === "turn.completed") {
        summary.turns = (summary.turns || 0) + 1;
        summary.providerStatus = "completed";
      }
    }
    if (worker === "codex" && event.type === "turn.failed") { codexFailed = true; summary.providerStatus = "failed"; }
    if (worker === "codex" && event.type === "thread.started" && event.model) {
      const reported = identifier(event.model);
      if (reported) { summary.modelId ||= reported; summary.modelSource ||= "provider-reported"; }
    }

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
        if (isVerify(item.command)) summary.verifyRuns += 1;
      }
      if (event.type === "item.completed") {
        if (!seenCommands.has(key)) {
          seenCommands.add(key);
          summary.toolCalls.command_execution = (summary.toolCalls.command_execution || 0) + 1;
          if (isVerify(item.command)) summary.verifyRuns += 1;
        }
        summary.toolResultChars.command_execution = (summary.toolResultChars.command_execution || 0) + size(item.aggregated_output || item.output);
      }
    }
  }
  if (worker === "claude" && result) {
    summary.turns = number(result.num_turns);
    const providerDuration = number(result.duration_ms);
    if (providerDuration !== null) { summary.durationMs = providerDuration; summary.durationSource = "provider-reported"; }
    summary.costUsd = number(result.total_cost_usd);
    if (summary.costUsd !== null) summary.costSource = "claude-reported-api-equivalent";
    const usage = result.usage || {};
    summary.inputTokens = number(usage.input_tokens);
    summary.outputTokens = number(usage.output_tokens);
    summary.cacheReadTokens = number(usage.cache_read_input_tokens);
    summary.cacheWriteTokens = number(usage.cache_creation_input_tokens);
    summary.thinkingTokens = number(usage.thinking_tokens);
    summary.usageEvents = result.usage && typeof result.usage === "object" ? 1 : 0;
    summary.usageAggregation = summary.usageEvents ? "single-event" : null;
    summary.providerStatus = identifier(result.subtype) || (result.is_error === true ? "error" : null);
    summary.modelsReported = Object.keys(result.modelUsage || {}).map(identifier).filter(Boolean).slice(0, 10);
    // A single reported model is the effective one; several (helper models)
    // leave the invocation's pinned model as the run's identity.
    if (summary.modelsReported.length === 1) { summary.modelId = summary.modelsReported[0]; summary.modelSource = "provider-reported"; }
    summary.partial = malformed;
  } else if (worker === "codex") {
    const folded = foldCodexUsage(codexUsageEvents);
    for (const [field, value] of Object.entries(folded.totals)) summary[field] = value;
    summary.usageEvents = folded.events;
    summary.usageAggregation = folded.aggregation;
    summary.partial = malformed || codexFailed || folded.events === 0;
  }
  if (summary.turns === null && number(observedTurns) !== null && observedTurns > 0) {
    summary.turns = observedTurns;
    summary.turnsSource = "dispatcher-observed";
  } else if (summary.turns !== null) {
    summary.turnsSource = TURN_SOURCES[worker] || null;
  }
  const exposed = EXPOSED_FIELDS[worker] || NUMERIC_FIELDS;
  for (const field of NUMERIC_FIELDS) {
    if (summary[field] !== null) summary.availability[field] = "reported";
    else if (exposed.includes(field)) summary.availability[field] = "not-reported";
    else {
      summary.availability[field] = "not-exposed";
      const note = NOT_EXPOSED_NOTES[worker]?.[field];
      if (note) summary.availabilityNotes[field] = note;
    }
  }
  return summary;
}

/** Derive the effective model and effort from the exact argv the worker was spawned with. */
export function usageContextFromInvocation(invocation, worker) {
  const args = Array.isArray(invocation?.args) ? invocation.args : [];
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  const codexEffort = args.find((arg) => typeof arg === "string" && arg.startsWith("model_reasoning_effort="));
  return {
    modelId: valueAfter("--model"),
    reasoningEffort: worker === "codex" ? codexEffort?.split("=")[1] ?? null : worker === "claude" ? valueAfter("--effort") : null,
  };
}

export class WorkerUsageStore extends JsonStateStore {
  get label() { return "worker usage"; }
  /** Append one attempt; a repeated attemptId is ignored so an attempt is never counted twice. */
  record(summary, { now = () => new Date() } = {}) {
    return this.update((state) => {
      if (!Array.isArray(state.runs)) state.runs = [];
      if (summary.attemptId && state.runs.some((run) => run.attemptId === summary.attemptId)) return false;
      state.runs.push({ ...summary, recordedAt: now().toISOString() });
      return true;
    });
  }
  recent() { return this.load().runs || []; }
}

export function captureWorkerUsage(logDir, context, { store = null, logger = console, now = () => new Date() } = {}) {
  try {
    let transcript = "";
    try { transcript = fs.readFileSync(path.join(logDir, "stdout.log"), "utf8"); } catch { /* missing log is partial */ }
    let timing = {};
    let manifestExit = null;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8"));
      const duration = Date.parse(manifest.endedAt) - Date.parse(manifest.startedAt);
      timing = { startedAt: manifest.startedAt, endedAt: manifest.endedAt, ...(Number.isFinite(duration) && duration >= 0 ? { wallDurationMs: duration } : {}) };
      if (typeof manifest.exitCode === "number") manifestExit = `exited-${manifest.exitCode}`;
    } catch { /* incomplete attempt */ }
    const attemptId = context.attemptId || `${identifier(context.attemptKind) || "attempt"}-${crypto.randomUUID()}`;
    const summary = parseWorkerUsage(transcript, {
      ...context, exitOutcome: context.exitOutcome ?? manifestExit, ...timing, durationMs: null, attemptId,
    });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "usage.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    store?.record(summary, { now });
    return summary;
  } catch (error) {
    logger.error(`Could not record worker usage for ${context.issue}: ${error.message}`);
    return null;
  }
}

export function formatUsageLine(usage) {
  if (!usage) return "Usage: unavailable.";
  const fields = [usage.modelId || usage.worker || "unknown model", `(${usage.tier || "unknown tier"})`];
  if (usage.reasoningEffort) fields.push(`effort: ${usage.reasoningEffort}`);
  if (usage.turns != null) fields.push(`${usage.turns} turns`);
  if (usage.durationMs != null) fields.push(`${Math.round(usage.durationMs / 60000)}m`);
  if (usage.costUsd != null) fields.push(`~$${usage.costUsd.toFixed(2)} API-equivalent`);
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

// ---------------------------------------------------------------------------
// Read-only trial export
// ---------------------------------------------------------------------------

const runTime = (run) => Date.parse(run.startedAt || run.recordedAt || "");
const isTrialRecord = (run) => (run.schemaVersion ?? 1) >= USAGE_SCHEMA_VERSION && run.origin === DISPATCHER_ORIGIN;

/**
 * Select attempts by explicit issue and/or run (attempt) IDs and a time window.
 * Categories AND together. By default only records the live dispatcher wrote
 * under this schema qualify, so historical fixture-like rows (no attemptId, no
 * dispatcher origin) never leak into a trial baseline; `includeLegacy` opts in.
 */
export function selectUsageRuns(runs, { issues = [], attemptIds = [], since = null, until = null, includeLegacy = false } = {}) {
  const sinceMs = since === null ? null : Date.parse(since);
  const untilMs = until === null ? null : Date.parse(until);
  const excluded = { legacyOrUnattributed: 0, filtered: 0, duplicates: 0 };
  const seen = new Set();
  const selected = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    if (!includeLegacy && !isTrialRecord(run)) { excluded.legacyOrUnattributed += 1; continue; }
    const time = runTime(run);
    const inWindow = (sinceMs === null || time >= sinceMs) && (untilMs === null || time <= untilMs);
    if ((issues.length && !issues.includes(run.issue)) || (attemptIds.length && !attemptIds.includes(run.attemptId)) || !inWindow) {
      excluded.filtered += 1;
      continue;
    }
    if (run.attemptId) {
      if (seen.has(run.attemptId)) { excluded.duplicates += 1; continue; }
      seen.add(run.attemptId);
    }
    selected.push(run);
  }
  selected.sort((a, b) => (runTime(a) || 0) - (runTime(b) || 0));
  return { selected, excluded };
}

/** Per-field counts of reported, zero and missing values; missing is split by why it is missing. */
export function usageCompleteness(runs) {
  const report = {};
  for (const field of NUMERIC_FIELDS) {
    const counts = { runs: runs.length, reported: 0, zero: 0, missing: 0, missingNotReported: 0, missingNotExposed: 0, missingUnknown: 0 };
    for (const run of runs) {
      const value = run[field];
      if (typeof value === "number") {
        counts.reported += 1;
        if (value === 0) counts.zero += 1;
        continue;
      }
      counts.missing += 1;
      const why = run.availability?.[field];
      if (why === "not-reported") counts.missingNotReported += 1;
      else if (why === "not-exposed") counts.missingNotExposed += 1;
      else counts.missingUnknown += 1;
    }
    report[field] = counts;
  }
  return report;
}

/** Sums only reported values; `sum` is null when nothing reported, never zero. */
function fieldTotals(rows, fields) {
  const totals = {};
  for (const field of fields) {
    const values = rows.map((row) => row[field]).filter((value) => typeof value === "number");
    totals[field] = { sum: values.length ? values.reduce((sum, value) => sum + value, 0) : null, reported: values.length, missing: rows.length - values.length };
  }
  return totals;
}
const countBy = (rows, key) => rows.reduce((counts, row) => {
  const name = row[key] || "unknown";
  counts[name] = (counts[name] || 0) + 1;
  return counts;
}, {});

/** Token counters are provider-defined, so per-issue sums are kept per worker, never mixed across harnesses. */
export function summarizeByIssue(runs) {
  const issues = new Map();
  for (const run of runs) {
    const name = run.issue || "unknown";
    if (!issues.has(name)) issues.set(name, []);
    issues.get(name).push(run);
  }
  return [...issues].map(([issue, rows]) => {
    const workers = new Map();
    for (const row of rows) {
      const name = row.worker || "unknown";
      if (!workers.has(name)) workers.set(name, []);
      workers.get(name).push(row);
    }
    return {
      issue,
      attempts: rows.length,
      attemptIds: rows.map((row) => row.attemptId).filter(Boolean),
      attemptsByKind: countBy(rows, "attemptKind"),
      attemptsByExitOutcome: countBy(rows, "exitOutcome"),
      partialAttempts: rows.filter((row) => row.partial).length,
      ...fieldTotals(rows, ["durationMs", "wallDurationMs"]),
      byWorker: [...workers].map(([worker, workerRows]) => ({
        worker,
        attempts: workerRows.length,
        modelIds: [...new Set(workerRows.map((row) => row.modelId).filter(Boolean))].sort(),
        tokenSemantics: workerRows[0].tokenSemantics ?? null,
        fields: fieldTotals(workerRows, NUMERIC_FIELDS),
      })).sort((a, b) => a.worker.localeCompare(b.worker)),
    };
  }).sort((a, b) => a.issue.localeCompare(b.issue));
}

export function buildUsageExport(allRuns, filters = {}, { now = () => new Date() } = {}) {
  const normalized = {
    issues: filters.issues || [], attemptIds: filters.attemptIds || [],
    since: filters.since ?? null, until: filters.until ?? null, includeLegacy: Boolean(filters.includeLegacy),
  };
  const { selected, excluded } = selectUsageRuns(allRuns, normalized);
  const selectedIssues = new Set(selected.map((run) => run.issue));
  const selectedAttempts = new Set(selected.map((run) => run.attemptId));
  return {
    readOnly: true,
    schemaVersion: USAGE_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    filters: normalized,
    totalRecords: allRuns.length,
    selectedRuns: selected.length,
    excluded,
    unmatched: {
      issues: normalized.issues.filter((issue) => !selectedIssues.has(issue)),
      attemptIds: normalized.attemptIds.filter((id) => !selectedAttempts.has(id)),
    },
    completeness: usageCompleteness(selected),
    byIssue: summarizeByIssue(selected),
    runs: selected,
  };
}

const EXPORT_USAGE = "usage export requires at least one of --issue <MOV-N>, --run <attemptId>, --since <ISO time>, --until <ISO time>";
/** Parse `usage export` flags. Throws a message-bearing Error for anything unrecognised or unselective. */
export function parseUsageExportArgs(argv) {
  const filters = { issues: [], attemptIds: [], since: null, until: null, includeLegacy: false };
  let statePath = null;
  const value = (index, flag) => {
    if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--include-legacy") { filters.includeLegacy = true; continue; }
    const arg = value(index, flag);
    index += 1;
    if (flag === "--issue" || flag === "--run") {
      if (!identifier(arg)) throw new Error(`${flag} ${JSON.stringify(arg)} is not a valid identifier`);
      (flag === "--issue" ? filters.issues : filters.attemptIds).push(arg);
    } else if (flag === "--since" || flag === "--until") {
      const parsed = Date.parse(arg);
      if (!Number.isFinite(parsed)) throw new Error(`${flag} ${JSON.stringify(arg)} is not a valid date`);
      filters[flag === "--since" ? "since" : "until"] = new Date(parsed).toISOString();
    } else if (flag === "--state") {
      statePath = arg;
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  if (!filters.issues.length && !filters.attemptIds.length && !filters.since && !filters.until) throw new Error(EXPORT_USAGE);
  return { filters, statePath };
}
