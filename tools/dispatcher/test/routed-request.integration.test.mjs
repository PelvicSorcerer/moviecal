// MOV-426: fixture routed-request streams through a run log and the
// read-only usage export, across implementation/continuation/resume/repair
// attempt kinds, including error and retry cases.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildUsageExport, captureWorkerUsage, WorkerUsageStore } from "../src/worker-usage.mjs";
import { parseRoutedRequests, writeRoutedRequestEvidence } from "../src/routed-request.mjs";
import {
  ROUTED_CACHE_HIT, ROUTED_MISSING_METADATA, ROUTED_RETRY_THEN_SUCCESS, ROUTED_STREAMING_SUCCESS,
} from "./routed-request-fixtures.mjs";

function writeAttemptLog(root, attemptKind, attemptId, fixtures) {
  const logDir = path.join(root, attemptKind);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "stdout.log"), "");
  for (const fixture of fixtures) {
    for (const record of parseRoutedRequests(fixture).records) writeRoutedRequestEvidence(logDir, { ...record, attemptId });
  }
  return logDir;
}

describe("routed-request run log and export integration (MOV-426)", () => {
  it("attaches each attempt's routed requests to its own usage.json, scoped by attemptId", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov426-attempt-"));
    try {
      const store = new WorkerUsageStore(path.join(root, "usage.json"));
      const implDir = writeAttemptLog(root, "implementation", "impl-1", [ROUTED_STREAMING_SUCCESS]);
      const repairDir = writeAttemptLog(root, "repair", "repair-1", [ROUTED_CACHE_HIT]);

      const implSummary = captureWorkerUsage(implDir, { issue: "MOV-426", attemptKind: "implementation", worker: "claude", tier: "default", attemptId: "impl-1", origin: "dispatcher" }, { store });
      const repairSummary = captureWorkerUsage(repairDir, { issue: "MOV-426", attemptKind: "repair", worker: "claude", tier: "default", attemptId: "repair-1", origin: "dispatcher" }, { store });

      expect(implSummary.routedRequests.map((r) => r.requestId)).toEqual(["req-1"]);
      expect(implSummary.routedInvoice).toMatchObject({ requests: 1, billedUsd: { sum: 0.0091, reported: 1 } });
      expect(repairSummary.routedRequests.map((r) => r.requestId)).toEqual(["req-4"]);
      expect(repairSummary.routedInvoice).toMatchObject({ requests: 1, cacheHits: 1 });

      const onDisk = JSON.parse(fs.readFileSync(path.join(implDir, "usage.json"), "utf8"));
      expect(onDisk.routedRequests.map((r) => r.requestId)).toEqual(["req-1"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("rolls implementation, continuation, resume and repair into one per-issue invoice total exactly once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov426-issue-"));
    try {
      const store = new WorkerUsageStore(path.join(root, "usage.json"));
      const kinds = [
        ["implementation", "impl-1", [ROUTED_STREAMING_SUCCESS]],
        ["continuation", "cont-1", [ROUTED_CACHE_HIT]],
        ["resume", "resume-1", [ROUTED_RETRY_THEN_SUCCESS]],
        ["repair", "repair-1", [ROUTED_MISSING_METADATA]],
      ];
      for (const [attemptKind, attemptId, fixtures] of kinds) {
        const logDir = writeAttemptLog(root, attemptKind, attemptId, fixtures);
        captureWorkerUsage(logDir, { issue: "MOV-426", attemptKind, worker: "claude", tier: "default", attemptId, origin: "dispatcher" }, { store });
      }

      const runs = store.recent();
      expect(runs).toHaveLength(4);
      const report = buildUsageExport(runs, { issues: ["MOV-426"] });
      expect(report.byIssue).toHaveLength(1);
      const [issueReport] = report.byIssue;
      expect(issueReport.attemptsByKind).toEqual({ implementation: 1, continuation: 1, resume: 1, repair: 1 });
      // req-1 (streaming), req-4 (cache hit), req-6a/req-6b folded to one retried request, req-2 (missing metadata): 4 requests total.
      expect(issueReport.routedInvoice.requests).toBe(4);
      expect(issueReport.routedInvoice.retries).toBe(1);
      expect(issueReport.routedInvoice.billedUsd.sum).toBeCloseTo(0.0091 + 0.0004 + 0.006, 5);
      expect(issueReport.routedInvoice.billedUsd.missing).toBe(1); // ROUTED_MISSING_METADATA never reports a charge
      expect(issueReport.routedInvoice.apiEquivalentUsd.sum).toBeCloseTo(0.012 + 0.005 + 0.007, 5);
      expect(issueReport.routedInvoice.apiEquivalentUsd.sum).not.toBe(issueReport.routedInvoice.billedUsd.sum);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("re-running the export over the same stored runs never double-counts a request", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov426-idempotent-"));
    try {
      const store = new WorkerUsageStore(path.join(root, "usage.json"));
      const logDir = writeAttemptLog(root, "implementation", "impl-1", [ROUTED_STREAMING_SUCCESS]);
      captureWorkerUsage(logDir, { issue: "MOV-426", attemptKind: "implementation", worker: "claude", tier: "default", attemptId: "impl-1", origin: "dispatcher" }, { store });

      const first = buildUsageExport(store.recent(), { issues: ["MOV-426"] });
      const second = buildUsageExport(store.recent(), { issues: ["MOV-426"] });
      expect(first.byIssue[0].routedInvoice).toEqual(second.byIssue[0].routedInvoice);
      expect(first.byIssue[0].routedInvoice.requests).toBe(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
