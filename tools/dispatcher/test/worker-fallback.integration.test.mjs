import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerCooldownStore } from "../src/worker-cooldown.mjs";
import { WorkerTrialStore } from "../src/worker-trial.mjs";
import { UsageLimitStore } from "../src/usage-limit.mjs";

const cli = path.resolve(import.meta.dirname, "../bin/dispatcher.mjs");

describe("MOV-395 read-only fallback previews", () => {
  it.each(["claude", "codex"])("shows fallback from requested %s with pins and bindings intact", (requested) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov395-preview-"));
    try {
      const now = new Date();
      const resetAt = new Date(now.getTime() + 3600_000).toISOString();
      const alternative = requested === "claude" ? "codex" : "claude";
      new WorkerCooldownStore(path.join(root, "worker-cooldowns.json")).record(requested, { resetAt, now });
      if (requested === "codex") new WorkerTrialStore({ configPath: path.join(root, "worker-trial.json"), ledgerPath: path.join(root, "worker-trial-assignments.json") })
        .activate({ trialId: "fixture", expiresAt: new Date(now.getTime() + 7200_000).toISOString(), maxAssignments: 3, now });
      new UsageLimitStore(path.join(root, "usage-limits.json")).record("MOV-BOUND", { worker: requested, retryAt: resetAt, now });
      const issues = [
        { id: "fresh", identifier: "MOV-FRESH", labels: ["worker:any"] },
        { id: "pin", identifier: "MOV-PIN", labels: [`worker:${requested}`] },
        { id: "bound", identifier: "MOV-BOUND", labels: ["worker:any"] },
      ].map((issue) => ({ ...issue, title: "fixture", description: "fixture", delegate: { name: "moviecal-dispatcher" }, labels: [...issue.labels, "execution:mac"], blockedByIds: [] }));
      const fixture = path.join(root, "issues.json");
      fs.writeFileSync(fixture, JSON.stringify(issues));
      const snapshot = () => Object.fromEntries(fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]));
      const before = snapshot();
      const result = spawnSync(process.execPath, [cli, "dry-run", "--fixture", fixture], { env: { ...process.env, MOVIECAL_CONFIG_DIR: root }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const freshOutput = result.stdout.split("- MOV-FRESH:")[1].split("- MOV-PIN:")[0];
      expect(freshOutput).toContain(`worker:   ${alternative}`);
      expect(freshOutput).toContain(`requested ${requested} worker unavailable`);
      expect(freshOutput).not.toContain("would be assigned at dispatch");
      expect(result.stdout.split("- MOV-PIN:")[1].split("- MOV-BOUND:")[0]).toContain(`worker:   ${requested}`);
      expect(result.stdout.split("- MOV-BOUND:")[1]).toContain(`worker:   ${requested}`);
      expect(snapshot()).toEqual(before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 20000);
});
