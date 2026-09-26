import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, workerUsageStatePath } from "../src/config.mjs";
import { buildRunContext, RUN_STATE_NAMES } from "../src/run-context.mjs";
import { WorkerUsageStore } from "../src/worker-usage.mjs";
import { CODEX_SINGLE_TURN } from "./usage-fixtures.mjs";

const DISPATCHER = path.resolve(import.meta.dirname, "../bin/dispatcher.mjs");
const linearClient = { workflowStates: async () => Object.values(RUN_STATE_NAMES).map((name) => ({ id: `id-${name}`, name })) };

describe("worker usage isolation and export (MOV-382)", () => {
  it("resolves every state path under the injected temporary config dir, never the live one", () => {
    const live = path.join(os.homedir(), ".config", "moviecal");
    expect(configDir()).toBe(process.env.MOVIECAL_CONFIG_DIR);
    expect(configDir().startsWith(live)).toBe(false);
    expect(workerUsageStatePath().startsWith(os.tmpdir())).toBe(true);
  });

  it("captures real-run wiring into an injected store, stamping dispatcher origin and distinct attempt ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov382-ctx-"));
    try {
      const store = new WorkerUsageStore(path.join(root, "usage.json"));
      const ctx = await buildRunContext(linearClient, "MOV", [], { workerUsageStore: store });
      for (const attemptKind of ["implementation", "repair"]) {
        const logDir = path.join(root, attemptKind);
        fs.mkdirSync(logDir);
        fs.writeFileSync(path.join(logDir, "stdout.log"), CODEX_SINGLE_TURN);
        ctx.captureWorkerUsageFn(logDir, { issue: "MOV-382", attemptKind, worker: "codex", tier: "default", modelId: "gpt-6-sol", reasoningEffort: "medium" });
      }
      const runs = store.recent();
      expect(runs.map((run) => run.attemptKind)).toEqual(["implementation", "repair"]);
      expect(runs.every((run) => run.origin === "dispatcher")).toBe(true);
      expect(new Set(runs.map((run) => run.attemptId)).size).toBe(2);
      // The default sink is the (test-relocated) config dir, so the live ledger is untouched.
      expect(fs.existsSync(workerUsageStatePath())).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("exports only the selected real runs from the CLI and leaves a sentinel live ledger unchanged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov382-cli-"));
    try {
      const sentinel = path.join(root, "live-worker-usage.json");
      const sentinelBody = JSON.stringify({ runs: [{ issue: "MOV-382", worker: "claude", turns: 3, costUsd: 0.25 }] });
      fs.writeFileSync(sentinel, sentinelBody);
      const statePath = path.join(root, "temp-usage.json");
      const store = new WorkerUsageStore(statePath);
      const record = (attemptId, issue, attemptKind, origin) => store.record({ schemaVersion: 2, attemptId, origin, issue, attemptKind, worker: "codex", startedAt: "2026-09-25T10:00:00.000Z", inputTokens: 5, availability: { inputTokens: "reported" } });
      record("real-impl", "MOV-382", "implementation", "dispatcher");
      record("real-repair", "MOV-382", "repair", "dispatcher");
      record("fixture", "MOV-382", "implementation", null);
      const before = fs.readFileSync(statePath, "utf8");

      const run = spawnSync(process.execPath, [DISPATCHER, "usage", "export", "--issue", "MOV-382", "--state", statePath], {
        env: { ...process.env, MOVIECAL_CONFIG_DIR: root }, encoding: "utf8",
      });
      expect(run.status).toBe(0);
      const report = JSON.parse(run.stdout);
      expect(report).toMatchObject({ readOnly: true, selectedRuns: 2, excluded: { legacyOrUnattributed: 1 } });
      expect(report.runs.map((r) => r.attemptId)).toEqual(["real-impl", "real-repair"]);
      expect(report.byIssue[0].attemptsByKind).toEqual({ implementation: 1, repair: 1 });
      expect(fs.readFileSync(statePath, "utf8")).toBe(before);
      expect(fs.readFileSync(sentinel, "utf8")).toBe(sentinelBody);

      const unselective = spawnSync(process.execPath, [DISPATCHER, "usage", "export", "--state", statePath], { env: { ...process.env, MOVIECAL_CONFIG_DIR: root }, encoding: "utf8" });
      expect(unselective.status).toBe(1);
      expect(unselective.stderr).toMatch(/requires at least one/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 20000);
});
