import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { workerInvocation } from "../src/worker-routing.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { captureWorkerUsage, formatUsageLine } from "../src/worker-usage.mjs";

// Exercise the real spawn/manifest/usage seam, with no process or network.
describe("Codex routing metadata (MOV-375)", () => {
  it.each([["cheap", "gpt-6-luna", "low"], ["default", "gpt-6-sol", "medium"], ["strong", "gpt-6-sol", "high"], ["cheap", "custom-model", "low"]])("records %s model %s and effort", async (tier, modelId, reasoningEffort) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov375-metadata-"));
    const key = `MOVIECAL_CODEX_MODEL_${tier.toUpperCase()}`;
    const prior = process.env[key];
    try {
      if (modelId === "custom-model") process.env[key] = modelId;
      const invocation = workerInvocation("codex", tier);
      // dry-run prints these same arguments verbatim for Codex.
      expect(`${invocation.command} ${invocation.args.join(" ")}`).toContain(`--model ${modelId}`);
      const result = await spawnWorker({ invocation, cwd: root, brief: "fixture", logDir: root, spawnImpl: (_command, args) => {
        expect(args).toEqual(invocation.args);
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => {
          child.stdout.end(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\n");
          child.stderr.end();
          queueMicrotask(() => child.emit("close", 0));
        });
        return child;
      } });
      expect(result.exitCode).toBe(0);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
      expect(manifest.args.slice(-4)).toEqual(["-c", `model_reasoning_effort=${reasoningEffort}`, "--model", modelId]);
      const usage = captureWorkerUsage(root, { worker: "codex", tier, modelId: manifest.args[manifest.args.indexOf("--model") + 1], reasoningEffort: manifest.args.find((arg) => arg.startsWith("model_reasoning_effort=")).split("=")[1] });
      expect(usage).toMatchObject({ modelId, reasoningEffort, inputTokens: 10 });
      expect(JSON.parse(fs.readFileSync(path.join(root, "usage.json"), "utf8"))).toMatchObject({ modelId, reasoningEffort });
      expect(formatUsageLine(usage)).toContain(modelId);
      expect(formatUsageLine(usage)).toContain(`effort: ${reasoningEffort}`);
    } finally {
      if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
