import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dedupeRoutedRequests, parseRoutedRequests, readRoutedRequestEvidence, summarizeRoutedInvoice, writeRoutedRequestEvidence,
} from "../src/routed-request.mjs";
import {
  ROUTED_CACHE_HIT, ROUTED_CACHE_MISS, ROUTED_MALFORMED, ROUTED_MISSING_METADATA, ROUTED_MODEL_SWITCH,
  ROUTED_RETRY_THEN_SUCCESS, ROUTED_STREAMING_SUCCESS,
} from "./routed-request-fixtures.mjs";

describe("routed-request parsing (MOV-426)", () => {
  it("folds a streaming response into one record with the resolved model/effort/provider and usage/charge", () => {
    const { records, malformedLines } = parseRoutedRequests(ROUTED_STREAMING_SUCCESS);
    expect(malformedLines).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      requestId: "req-1", issue: "MOV-426", attemptId: "impl-1", turn: 1,
      routerArm: "hosted-openrouter-jev", policyHash: "sha256:aaaaaaaa",
      requestedModel: "anthropic/claude-sonnet-5", resolvedModel: "anthropic/claude-sonnet-5",
      requestedEffort: "medium", resolvedEffort: "medium", provider: "anthropic", streamed: true,
      inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0, cacheStatus: "hit",
      latencyMs: 842, apiEquivalentUsd: 0.012, billedUsd: 0.0091, invoiceId: "or-gen-001",
      fallback: false, error: null, retryCount: 0, modelSwitch: false, malformed: false,
    });
    expect(records[0].availability).toMatchObject({
      routerArm: "reported", policyHash: "reported", resolvedModel: "reported", billedUsd: "reported", invoiceId: "reported",
    });
  });

  it("leaves every unreported field null with an explicit missing marker, never inventing served model/effort/provider", () => {
    const { records } = parseRoutedRequests(ROUTED_MISSING_METADATA);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      routerArm: null, policyHash: null, resolvedModel: null, resolvedEffort: null, provider: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheStatus: "unknown",
      apiEquivalentUsd: null, billedUsd: null, invoiceId: null,
    });
    expect(records[0].availability).toMatchObject({
      routerArm: "missing", resolvedModel: "missing", billedUsd: "missing", invoiceId: "missing",
    });
  });

  it("keeps every observed model across a mid-stream switch and flags it, with the last one as resolved", () => {
    const { records } = parseRoutedRequests(ROUTED_MODEL_SWITCH);
    expect(records[0]).toMatchObject({
      modelsObserved: ["anthropic/claude-sonnet-5", "openai/gpt-6-sol"], resolvedModel: "openai/gpt-6-sol",
      modelSwitch: true, fallback: true, fallbackReason: "candidate-unavailable",
    });
  });

  it("marks a positive cache-read count as a hit and a zero count as a miss, never leaving it unknown when reported", () => {
    expect(parseRoutedRequests(ROUTED_CACHE_HIT).records[0]).toMatchObject({ cacheStatus: "hit", cacheReadTokens: 3500 });
    expect(parseRoutedRequests(ROUTED_CACHE_MISS).records[0]).toMatchObject({ cacheStatus: "miss", cacheReadTokens: 0, cacheWriteTokens: 4000 });
  });

  it("folds a retried request into one record, summing billed dollars across both attempts and keeping both invoice IDs", () => {
    const { records } = parseRoutedRequests(ROUTED_RETRY_THEN_SUCCESS);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      requestId: "req-6a", retryCount: 1, retriedRequestIds: ["req-6a"],
      resolvedModel: "anthropic/claude-sonnet-5", error: null, fallback: false,
      billedUsd: 0.006, apiEquivalentUsd: 0.007, invoiceId: "or-gen-006b",
    });
    expect(records[0].invoiceIds.sort()).toEqual(["or-gen-006a", "or-gen-006b"]);
  });

  it("counts a malformed line without inventing a record for it, and marks an unterminated request malformed", () => {
    const { records, malformedLines, totalLines } = parseRoutedRequests(ROUTED_MALFORMED);
    expect(malformedLines).toBeGreaterThanOrEqual(1);
    expect(totalLines).toBeGreaterThan(malformedLines);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestId: "req-7", malformed: true, billedUsd: null });
  });

  it("drops a repeated requestId instead of counting it twice", () => {
    const { records } = parseRoutedRequests(ROUTED_STREAMING_SUCCESS);
    const deduped = dedupeRoutedRequests([...records, ...records]);
    expect(deduped).toHaveLength(1);
  });
});

describe("routed-request invoice rollup (MOV-426)", () => {
  it("distinguishes API-equivalent dollars from actual billed dollars and counts cache/retry/switch stats", () => {
    const all = [
      ROUTED_STREAMING_SUCCESS, ROUTED_MODEL_SWITCH, ROUTED_CACHE_HIT, ROUTED_CACHE_MISS, ROUTED_RETRY_THEN_SUCCESS,
    ].flatMap((fixture) => parseRoutedRequests(fixture).records);
    const summary = summarizeRoutedInvoice(all);
    expect(summary.requests).toBe(5);
    expect(summary.retries).toBe(1);
    expect(summary.modelSwitches).toBe(1);
    expect(summary.cacheHits).toBe(3);
    expect(summary.cacheMisses).toBe(2);
    expect(summary.cacheUnknown).toBe(0);
    expect(summary.apiEquivalentUsd.sum).toBeCloseTo(0.012 + 0.008 + 0.005 + 0.02 + 0.007, 5);
    expect(summary.billedUsd.sum).toBeCloseTo(0.0091 + 0.006 + 0.0004 + 0.018 + 0.006, 5);
    expect(summary.billedUsd.sum).not.toBe(summary.apiEquivalentUsd.sum);
  });

  it("never counts a duplicate requestId twice in the rollup", () => {
    const records = parseRoutedRequests(ROUTED_STREAMING_SUCCESS).records;
    const summary = summarizeRoutedInvoice([...records, ...records]);
    expect(summary.requests).toBe(1);
    expect(summary.billedUsd.sum).toBeCloseTo(0.0091, 5);
  });

  it("reports null (not zero) when nothing in the set has a reported dollar amount", () => {
    const summary = summarizeRoutedInvoice(parseRoutedRequests(ROUTED_MISSING_METADATA).records);
    expect(summary.apiEquivalentUsd).toEqual({ sum: null, reported: 0, missing: 1 });
    expect(summary.billedUsd).toEqual({ sum: null, reported: 0, missing: 1 });
  });
});

describe("routed-request evidence I/O (MOV-426)", () => {
  it("writes only known, bounded fields with restrictive permissions and reads them back scoped to one attempt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov426-evidence-"));
    try {
      const [record] = parseRoutedRequests(ROUTED_STREAMING_SUCCESS).records;
      writeRoutedRequestEvidence(root, { ...record, secretField: "leak-me", requestedModel: "leaked prompt text with spaces" });
      const file = path.join(root, "routing-decisions.jsonl");
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toContain("leak-me");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const rows = text.trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("routed-request");
      // Free-text with spaces is not a bounded identifier, so it is dropped rather than written verbatim.
      expect(rows[0].requestedModel).toBeNull();

      const other = { ...record, requestId: "req-other", attemptId: "impl-2" };
      writeRoutedRequestEvidence(root, other);
      expect(readRoutedRequestEvidence(root, { attemptId: "impl-1" }).map((r) => r.requestId)).toEqual(["req-1"]);
      expect(readRoutedRequestEvidence(root).map((r) => r.requestId).sort()).toEqual(["req-1", "req-other"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores routing-decision (poll/spawn) rows interleaved in the same file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov426-mixed-"));
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.appendFileSync(path.join(root, "routing-decisions.jsonl"), `${JSON.stringify({ kind: "routing-decision", issue: "MOV-426", decision: "unchanged" })}\n`);
      const [record] = parseRoutedRequests(ROUTED_STREAMING_SUCCESS).records;
      writeRoutedRequestEvidence(root, record);
      expect(readRoutedRequestEvidence(root)).toHaveLength(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("returns an empty list rather than throwing when routing-decisions.jsonl does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov426-missing-"));
    try { expect(readRoutedRequestEvidence(root)).toEqual([]); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
