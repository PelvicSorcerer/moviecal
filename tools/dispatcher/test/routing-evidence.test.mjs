import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { confirmRoutingUnchanged, routingInputs } from "../src/worker-routing.mjs";
import { writeRoutingEvidence } from "../src/routing-evidence.mjs";

describe("bounded routing evidence", () => {
  it("omits unknown label contents and detects conflicts even when both snapshots contain them", () => {
    const issue = { labels: ["worker:codex", "worker:claude", "model:default", "worker:secret-value", "area:private-value"] };
    const check = confirmRoutingUnchanged(issue, issue);
    expect(check.ok).toBe(false);
    expect(JSON.stringify(check)).not.toContain("secret-value");
    expect(JSON.stringify(check)).not.toContain("private-value");
    expect(check.refreshed.worker).toEqual({ values: ["worker:claude", "worker:codex"], count: 2, invalid: true });
  });

  it("defers removal of a strong tier's upgrade condition", () => {
    const issue = { labels: ["worker:codex", "model:strong", "upgrade:architecture"] };
    expect(confirmRoutingUnchanged(issue, { labels: ["worker:codex", "model:strong"] }).ok).toBe(false);
  });

  it("rejects an unchanged strong tier with only an unrecognized upgrade condition", () => {
    const issue = { labels: ["worker:codex", "model:strong", "upgrade:unknown-value"] };
    const result = confirmRoutingUnchanged(issue, issue);
    expect(result.ok).toBe(false);
    expect(result.refreshed.upgrades).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("unknown-value");
  });

  it("appends decisions with restrictive permissions and no arbitrary record fields or model text", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov397-evidence-"));
    try {
      const inputs = routingInputs({ labels: ["worker:codex", "model:cheap", "area:private-value"] });
      const record = { issue: "MOV-397", at: "2026-09-26T00:00:00.000Z", decision: "unchanged", poll: inputs, refreshed: inputs,
        selected: { worker: "codex", tier: "cheap", modelId: "private model contents", reasoningEffort: "low", turnBudget: 10, reason: "labels-or-default", prompt: "secret" },
        description: "secret",
      };
      writeRoutingEvidence(root, record);
      writeRoutingEvidence(root, { ...record, decision: "spawn-requested" });
      const file = path.join(root, "routing-decisions.jsonl");
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toMatch(/secret|private/);
      const rows = text.trim().split("\n").map(JSON.parse);
      expect(rows.map((row) => row.decision)).toEqual(["unchanged", "spawn-requested"]);
      expect(rows[1].selected.modelId).toBeNull();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
