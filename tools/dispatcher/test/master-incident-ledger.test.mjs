import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MasterIncidentLedger } from "../src/master-incident-ledger.mjs";

let dir;
let ledger;

const KEY = "master-ci:4242:1:aaaa";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-incident-"));
  ledger = new MasterIncidentLedger(path.join(dir, "master-incidents.json"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("master incident ledger (MOV-305)", () => {
  it("persists the observation before anything else exists on the record", () => {
    const incident = ledger.observe(KEY, { runId: 4242, headSha: "aaaa" });
    expect(incident.status).toBe("observed");
    expect(incident.remediation).toBeNull();
    expect(incident.decision).toBeNull();
    // Durable immediately: a crash right here still leaves the evidence.
    expect(new MasterIncidentLedger(ledger.statePath).get(KEY).evidence.runId).toBe(4242);
  });

  it("is idempotent: re-observing counts the observation without rewriting evidence or status", () => {
    ledger.observe(KEY, { runId: 4242, headSha: "aaaa", classification: "code-test" });
    ledger.attachRemediation(KEY, { id: "linear-1", identifier: "MOV-999" });
    ledger.setStatus(KEY, "routed", "routed once");
    const again = ledger.observe(KEY, { runId: 4242, headSha: "aaaa", classification: "something-else" });
    expect(again.observationCount).toBe(2);
    expect(again.status).toBe("routed");
    expect(again.evidence.classification).toBe("code-test");
    expect(again.remediation.identifier).toBe("MOV-999");
  });

  it("folds late-arriving evidence in without losing what was recorded first", () => {
    ledger.observe(KEY, { runId: 4242, headSha: "aaaa" });
    const merged = ledger.mergeEvidence(KEY, { prNumber: 602, sourceIssue: "MOV-293" });
    expect(merged.evidence).toMatchObject({ runId: 4242, headSha: "aaaa", prNumber: 602, sourceIssue: "MOV-293" });
  });

  it("counts only routed incidents against the automatic remediation budget", () => {
    ledger.observe("a", {});
    ledger.attachRemediation("a", { identifier: "MOV-1" });
    ledger.setStatus("a", "routed");
    ledger.observe("b", {});
    ledger.attachRemediation("b", { identifier: "MOV-2" });
    ledger.setStatus("b", "needs-human-decision");
    expect(ledger.routedCount()).toBe(1);
  });

  it("records each side effect once, so a restart mid-pass cannot duplicate a comment", () => {
    ledger.observe(KEY, {});
    expect(ledger.hasEffect(KEY, "routed")).toBe(false);
    ledger.markEffect(KEY, "routed");
    expect(ledger.hasEffect(KEY, "routed")).toBe(true);
    expect(new MasterIncidentLedger(ledger.statePath).hasEffect(KEY, "routed")).toBe(true);
  });

  it("keeps the original failure evidence and history after reconciliation", () => {
    ledger.observe(KEY, { runId: 4242, headSha: "aaaa", classification: "code-test" });
    ledger.attachRemediation(KEY, { identifier: "MOV-999" });
    ledger.setStatus(KEY, "routed");
    const reconciled = ledger.reconcile(KEY, { prNumber: 700, verifiedSha: "cccc", reason: "green on cccc" });
    expect(reconciled.status).toBe("reconciled");
    expect(reconciled.evidence).toMatchObject({ runId: 4242, headSha: "aaaa", classification: "code-test" });
    expect(reconciled.reconciliation.verifiedSha).toBe("cccc");
    expect(reconciled.history.map((entry) => entry.status)).toEqual(["observed", "recorded", "routed", "reconciled"]);
    expect(ledger.open()).toHaveLength(0);
  });

  it("offers open incidents for reconciliation least-recently-checked first, and reports what it deferred", () => {
    for (const name of ["a", "b", "c"]) {
      ledger.observe(name, {});
      ledger.attachRemediation(name, { identifier: `MOV-${name}` });
      ledger.setStatus(name, "routed");
    }
    // Never checked sorts before checked, so nothing starves behind a cap.
    ledger.markReconcileCheck("a", { now: new Date("2026-09-23T00:00:00Z") });
    ledger.markReconcileCheck("b", { now: new Date("2026-09-24T00:00:00Z") });
    const first = ledger.dueForReconciliation(2);
    expect(first.due.map((incident) => incident.key)).toEqual(["c", "a"]);
    expect(first.deferred).toBe(1);

    ledger.markReconcileCheck("c", { now: new Date("2026-09-25T00:00:00Z") });
    ledger.markReconcileCheck("a", { now: new Date("2026-09-26T00:00:00Z") });
    expect(ledger.dueForReconciliation(2).due.map((incident) => incident.key)).toEqual(["b", "c"]);
  });

  it("never offers an incident with no remediation item, or a reconciled one", () => {
    ledger.observe("no-issue", {});
    ledger.observe("done", {});
    ledger.attachRemediation("done", { identifier: "MOV-1" });
    ledger.reconcile("done", { reason: "green" });
    expect(ledger.dueForReconciliation(10)).toEqual({ due: [], deferred: 0 });
  });

  it("refuses an unknown status rather than writing one nothing else understands", () => {
    ledger.observe(KEY, {});
    expect(() => ledger.setStatus(KEY, "repaired-master")).toThrow(/unknown master incident status/);
  });

  it("recovers from a corrupt primary state file via its backup", () => {
    ledger.observe(KEY, { runId: 4242 });
    ledger.mergeEvidence(KEY, { prNumber: 1 });
    fs.writeFileSync(ledger.statePath, "{ not json", "utf8");
    expect(new MasterIncidentLedger(ledger.statePath).get(KEY).evidence.runId).toBe(4242);
  });
});
