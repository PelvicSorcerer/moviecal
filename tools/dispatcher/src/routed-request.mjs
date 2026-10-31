// Bounded per-request routed-model accounting (MOV-426).
//
// Live routing (the Jev router trial, MOV-422) has no credential broker or
// provider wiring yet -- MOV-427/MOV-428 own that. This module fixes the
// bounded, redacted broker-event contract that a future broker must emit,
// and the parser/reducer that folds a stream of those events into exactly
// one record per logical routed request. That lets the accounting side of
// MOV-422 (this issue and MOV-431) be built, reviewed and tested ahead of
// any live credential or provider work, per the design doc's "accounting and
// controls can be implemented independently of the live router plumbing."
//
// Only structured identifiers, model/effort/provider names, token counts,
// latency and USD amounts ever appear here. A broker must never emit a
// prompt, tool payload, header or credential in one of these events, and
// this module does not accept or forward arbitrary text even if a caller
// passed it in -- every string field is either a bounded identifier or
// truncated to a short, fixed length.
//
// Broker event shapes (one JSON object per line, matching one routed
// request -- one worker "turn" dispatched through the router):
//   {type:"request.start", requestId, issue, attemptId, turn, routerArm,
//    policyHash, requestedModel, requestedEffort, retryOf}
//   {type:"request.chunk", requestId, resolvedModel, resolvedEffort,
//    provider, streamed}            -- zero or more, for streaming responses
//   {type:"request.usage", requestId, usage:{inputTokens, outputTokens,
//    cacheReadTokens, cacheWriteTokens}}
//   {type:"request.end", requestId, latencyMs, apiEquivalentUsd, billedUsd,
//    invoiceId, fallback, fallbackReason, error}
//
// A "logical request" is a `request.start` chain: a retry's `request.start`
// sets `retryOf` to the requestId it replaces, chaining back to one root. A
// record is keyed by that root, so a retried call is never double-counted as
// two separate accepted turns; its *last* attempt supplies the resolved
// model/effort/provider/usage/status, while `apiEquivalentUsd`/`billedUsd`
// sum every attempt in the chain, because a provider can still invoice a
// failed attempt even though it was not accepted.

import fs from "node:fs";
import path from "node:path";

export const ROUTED_REQUEST_SCHEMA_VERSION = 1;

const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : null;
const boundedText = (value, max = 200) => typeof value === "string" ? value.slice(0, max) : null;
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value) => typeof value === "boolean" ? value : null;
// USD sums accumulate in floating point; round to the nearest hundred-thousandth
// of a dollar so repeated folding never produces cosmetic float noise.
const round = (value) => Math.round(value * 1e5) / 1e5;

function sumField(attempts, getter) {
  const values = attempts.map(getter).filter((value) => typeof value === "number");
  return values.length ? round(values.reduce((sum, value) => sum + value, 0)) : null;
}

/**
 * Fold one request's attempt chain (the original plus any retries) into a
 * single bounded record. `availability` marks each accounting field
 * "reported" or "missing" -- there is exactly one source (the broker), so
 * unlike worker-usage's multi-provider not-reported/not-exposed split, a
 * missing field here has one explicit meaning: the broker never reported it.
 */
function foldChain(root, attempts) {
  const last = attempts[attempts.length - 1] || {};
  const lastChunks = last.chunks || [];
  const modelsObserved = [...new Set(lastChunks.map((chunk) => chunk.resolvedModel).filter(Boolean))];
  const effortsObserved = [...new Set(lastChunks.map((chunk) => chunk.resolvedEffort).filter(Boolean))];
  const providersObserved = [...new Set(lastChunks.map((chunk) => chunk.provider).filter(Boolean))];
  const usage = last.usage || {};
  const end = last.end || {};
  const cacheReadTokens = number(usage.cacheReadTokens);

  const record = {
    schemaVersion: ROUTED_REQUEST_SCHEMA_VERSION,
    requestId: root,
    issue: last.issue ?? attempts[0]?.issue ?? null,
    attemptId: last.attemptId ?? attempts[0]?.attemptId ?? null,
    turn: last.turn ?? attempts[0]?.turn ?? null,
    routerArm: last.routerArm ?? attempts[0]?.routerArm ?? null,
    policyHash: last.policyHash ?? attempts[0]?.policyHash ?? null,
    requestedModel: last.requestedModel ?? attempts[0]?.requestedModel ?? null,
    resolvedModel: modelsObserved.length ? modelsObserved[modelsObserved.length - 1] : null,
    modelsObserved,
    modelSwitch: modelsObserved.length > 1,
    requestedEffort: last.requestedEffort ?? attempts[0]?.requestedEffort ?? null,
    resolvedEffort: effortsObserved.length ? effortsObserved[effortsObserved.length - 1] : null,
    provider: providersObserved.length ? providersObserved[providersObserved.length - 1] : null,
    streamed: lastChunks.some((chunk) => chunk.streamed === true),
    inputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    cacheReadTokens,
    cacheWriteTokens: number(usage.cacheWriteTokens),
    cacheStatus: cacheReadTokens === null ? "unknown" : cacheReadTokens > 0 ? "hit" : "miss",
    latencyMs: number(end.latencyMs),
    apiEquivalentUsd: sumField(attempts, (attempt) => attempt.end?.apiEquivalentUsd),
    billedUsd: sumField(attempts, (attempt) => attempt.end?.billedUsd),
    invoiceId: end.invoiceId ?? null,
    invoiceIds: [...new Set(attempts.map((attempt) => attempt.end?.invoiceId).filter(Boolean))],
    fallback: end.fallback ?? null,
    fallbackReason: end.fallbackReason ?? null,
    error: end.error ?? null,
    retryCount: attempts.length - 1,
    retriedRequestIds: attempts.slice(0, -1).map((attempt) => attempt.requestId),
    malformed: !last.end,
  };
  const trackedFields = [
    "routerArm", "policyHash", "resolvedModel", "resolvedEffort", "provider",
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "latencyMs", "apiEquivalentUsd", "billedUsd", "invoiceId",
  ];
  record.availability = {};
  for (const field of trackedFields) record.availability[field] = record[field] === null ? "missing" : "reported";
  return record;
}

/**
 * Parse a bounded broker-event NDJSON transcript for one worker attempt into
 * one record per logical (retry-folded) routed request. An unparsable line,
 * an event missing its `type`/`requestId`, or a non-`request.start` event
 * whose requestId was never opened is counted in `malformedLines` and
 * otherwise ignored -- it never invents a record or a field value.
 */
export function parseRoutedRequests(transcript) {
  const attemptsById = new Map();
  const rootById = new Map();
  const chainOrder = new Map(); // root -> ordered requestIds
  let malformedLines = 0;
  let totalLines = 0;

  for (const line of String(transcript || "").split("\n")) {
    if (!line.trim()) continue;
    totalLines += 1;
    let event;
    try { event = JSON.parse(line); } catch { malformedLines += 1; continue; }
    if (!event || typeof event !== "object" || typeof event.type !== "string") { malformedLines += 1; continue; }
    const requestId = identifier(event.requestId);
    if (!requestId) { malformedLines += 1; continue; }

    if (event.type === "request.start") {
      const retryOf = identifier(event.retryOf);
      const root = retryOf && rootById.has(retryOf) ? rootById.get(retryOf) : requestId;
      rootById.set(requestId, root);
      if (!chainOrder.has(root)) chainOrder.set(root, []);
      chainOrder.get(root).push(requestId);
      attemptsById.set(requestId, {
        requestId, issue: identifier(event.issue), attemptId: identifier(event.attemptId),
        turn: number(event.turn), routerArm: identifier(event.routerArm), policyHash: identifier(event.policyHash),
        requestedModel: identifier(event.requestedModel), requestedEffort: identifier(event.requestedEffort),
      });
      continue;
    }

    const attempt = attemptsById.get(requestId);
    if (!attempt) { malformedLines += 1; continue; } // event before its request.start

    if (event.type === "request.chunk") {
      attempt.chunks ??= [];
      attempt.chunks.push({
        resolvedModel: identifier(event.resolvedModel), resolvedEffort: identifier(event.resolvedEffort),
        provider: identifier(event.provider), streamed: bool(event.streamed),
      });
    } else if (event.type === "request.usage") {
      const usage = event.usage && typeof event.usage === "object" ? event.usage : {};
      attempt.usage = {
        inputTokens: number(usage.inputTokens), outputTokens: number(usage.outputTokens),
        cacheReadTokens: number(usage.cacheReadTokens), cacheWriteTokens: number(usage.cacheWriteTokens),
      };
    } else if (event.type === "request.end") {
      attempt.end = {
        latencyMs: number(event.latencyMs), apiEquivalentUsd: number(event.apiEquivalentUsd), billedUsd: number(event.billedUsd),
        invoiceId: identifier(event.invoiceId), fallback: bool(event.fallback),
        fallbackReason: boundedText(event.fallbackReason), error: boundedText(event.error),
      };
    } else {
      malformedLines += 1;
    }
  }

  const records = [...chainOrder.entries()].map(([root, ids]) => foldChain(root, ids.map((id) => attemptsById.get(id))));
  return { records, malformedLines, totalLines };
}

/** Drop a repeated requestId (e.g. the same log ingested twice); first record wins. */
export function dedupeRoutedRequests(records) {
  const seen = new Map();
  for (const record of records || []) {
    if (!record || !record.requestId) continue;
    if (!seen.has(record.requestId)) seen.set(record.requestId, record);
  }
  return [...seen.values()];
}

/**
 * Roll a set of routed-request records into one invoice summary,
 * distinguishing Claude-style API-equivalent dollars from actual provider
 * (e.g. OpenRouter) billed dollars, and never double-counting a duplicate
 * requestId.
 */
export function summarizeRoutedInvoice(records) {
  const deduped = dedupeRoutedRequests(records);
  const apiEquivalent = deduped.map((record) => record.apiEquivalentUsd).filter((value) => typeof value === "number");
  const billed = deduped.map((record) => record.billedUsd).filter((value) => typeof value === "number");
  const cacheHits = deduped.filter((record) => record.cacheStatus === "hit").length;
  const cacheMisses = deduped.filter((record) => record.cacheStatus === "miss").length;
  const byRouterArm = {};
  for (const record of deduped) {
    const arm = record.routerArm || "unknown";
    byRouterArm[arm] = (byRouterArm[arm] || 0) + 1;
  }
  return {
    requests: deduped.length,
    retries: deduped.reduce((sum, record) => sum + (record.retryCount || 0), 0),
    modelSwitches: deduped.filter((record) => record.modelSwitch).length,
    malformed: deduped.filter((record) => record.malformed).length,
    cacheHits, cacheMisses, cacheUnknown: deduped.length - cacheHits - cacheMisses,
    apiEquivalentUsd: { sum: apiEquivalent.length ? round(apiEquivalent.reduce((sum, value) => sum + value, 0)) : null, reported: apiEquivalent.length, missing: deduped.length - apiEquivalent.length },
    billedUsd: { sum: billed.length ? round(billed.reduce((sum, value) => sum + value, 0)) : null, reported: billed.length, missing: deduped.length - billed.length },
    byRouterArm,
  };
}

/**
 * Re-sanitize an already-folded record before it leaves the process: a
 * defense-in-depth boundary independent of parseRoutedRequests's own
 * bounding, matching writeRoutingEvidence's explicit-allowlist style. Only
 * known keys are ever written; no field carries unbounded prompt/tool text.
 */
export function writeRoutedRequestEvidence(logDir, record) {
  const boundedId = (value) => identifier(value);
  const boundedList = (value) => Array.isArray(value) ? value.map(boundedId).filter(Boolean).slice(0, 10) : [];
  const numberOrNull = (value) => number(value);
  const evidence = {
    kind: "routed-request",
    schemaVersion: ROUTED_REQUEST_SCHEMA_VERSION,
    source: identifier(record?.source),
    toolCalls: Number.isSafeInteger(record?.toolCalls) && record.toolCalls >= 0 ? record.toolCalls : null,
    toolOutputs: Number.isSafeInteger(record?.toolOutputs) && record.toolOutputs >= 0 ? record.toolOutputs : null,
    requestId: boundedId(record?.requestId),
    issue: boundedId(record?.issue),
    attemptId: boundedId(record?.attemptId),
    turn: numberOrNull(record?.turn),
    routerArm: boundedId(record?.routerArm),
    policyHash: boundedId(record?.policyHash),
    requestedModel: boundedId(record?.requestedModel),
    resolvedModel: boundedId(record?.resolvedModel),
    modelsObserved: boundedList(record?.modelsObserved),
    modelSwitch: record?.modelSwitch === true,
    requestedEffort: boundedId(record?.requestedEffort),
    resolvedEffort: boundedId(record?.resolvedEffort),
    provider: boundedId(record?.provider),
    streamed: record?.streamed === true,
    inputTokens: numberOrNull(record?.inputTokens),
    outputTokens: numberOrNull(record?.outputTokens),
    cacheReadTokens: numberOrNull(record?.cacheReadTokens),
    cacheWriteTokens: numberOrNull(record?.cacheWriteTokens),
    cacheStatus: ["hit", "miss", "unknown"].includes(record?.cacheStatus) ? record.cacheStatus : "unknown",
    latencyMs: numberOrNull(record?.latencyMs),
    apiEquivalentUsd: numberOrNull(record?.apiEquivalentUsd),
    billedUsd: numberOrNull(record?.billedUsd),
    invoiceId: boundedId(record?.invoiceId),
    invoiceIds: boundedList(record?.invoiceIds),
    fallback: record?.fallback === true ? true : record?.fallback === false ? false : null,
    fallbackReason: boundedText(record?.fallbackReason),
    error: boundedText(record?.error),
    retryCount: typeof record?.retryCount === "number" && Number.isFinite(record.retryCount) ? record.retryCount : 0,
    retriedRequestIds: boundedList(record?.retriedRequestIds),
    availability: record?.availability && typeof record.availability === "object" ? record.availability : {},
    malformed: record?.malformed === true,
  };
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, "routing-decisions.jsonl"), `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
}

/** Read only the `routed-request` rows of a run's routing-decisions.jsonl, optionally scoped to one attempt. */
export function readRoutedRequestEvidence(logDir, { attemptId = null } = {}) {
  let raw = "";
  try { raw = fs.readFileSync(path.join(logDir, "routing-decisions.jsonl"), "utf8"); } catch { return []; }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || event.kind !== "routed-request") continue;
    if (attemptId && event.attemptId && event.attemptId !== attemptId) continue;
    records.push(event);
  }
  return dedupeRoutedRequests(records);
}
