import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { budgetHandoffSections, readWorkerProgress, turnBudgetForTier, wrapUpAt } from "../src/turn-budget.mjs";
import { makeAssistantTurnCounter } from "../src/worker-spawn.mjs";
import { admitBudgetContinuation } from "../src/usage-limit-resume.mjs";
import { workerInvocation } from "../src/worker-routing.mjs";

describe("turn budget", () => {
  it("validates tier overrides and rounds the wrap-up threshold up", () => {
    expect(turnBudgetForTier("cheap", {})).toBe(60);
    expect(turnBudgetForTier("default", { MOVIECAL_TURN_BUDGET_DEFAULT: "8" })).toBe(8);
    expect(wrapUpAt(8)).toBe(7);
    for (const invalid of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
      expect(() => turnBudgetForTier("strong", { MOVIECAL_TURN_BUDGET_STRONG: invalid })).toThrow(/invalid MOVIECAL_TURN_BUDGET_STRONG/);
    }
  });

  it("fails worker routing loudly for an invalid override", () => {
    const previous = process.env.MOVIECAL_TURN_BUDGET_DEFAULT;
    process.env.MOVIECAL_TURN_BUDGET_DEFAULT = "none";
    try { expect(() => workerInvocation("claude", "default")).toThrow(/invalid MOVIECAL_TURN_BUDGET_DEFAULT/); }
    finally {
      if (previous === undefined) delete process.env.MOVIECAL_TURN_BUDGET_DEFAULT;
      else process.env.MOVIECAL_TURN_BUDGET_DEFAULT = previous;
    }
  });

  it("counts live Claude assistant messages once per id and Codex completed turns", () => {
    const claude = [];
    const countClaude = makeAssistantTurnCounter("claude", (n) => claude.push(n));
    countClaude(Buffer.from('{"type":"assistant","message":{"role":"assistant","id":"a"}}\n{"type":"assis'));
    countClaude(Buffer.from('tant","message":{"role":"assistant","id":"a"}}\n{"type":"assistant","message":{"role":"assistant","id":"b"}}\n{"type":"result","num_turns":2}\n'));
    expect(claude).toEqual([1, 2]);
    const codex = [];
    makeAssistantTurnCounter("codex", (n) => codex.push(n))('{"type":"turn.completed"}\n{"type":"turn.completed"}\n');
    expect(codex).toEqual([1, 2]);
  });

  it("bounds and redacts worker-written progress and renders absent progress explicitly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mov367-progress-"));
    try {
      expect(readWorkerProgress(dir)).toBe("Progress file missing.");
      fs.writeFileSync(path.join(dir, "WORKER_PROGRESS.md"), "TOKEN=supersecretvalue\n```\nBearer accidentalcredential\n" + "x".repeat(5000));
      const excerpt = readWorkerProgress(dir);
      expect(excerpt).toContain("[REDACTED]");
      expect(excerpt).not.toContain("supersecretvalue");
      expect(excerpt).not.toContain("accidentalcredential");
      expect(excerpt).not.toContain("```");
      expect(excerpt).toContain("[truncated]");
      expect(excerpt.length).toBeLessThan(4200);
      const sections = budgetHandoffSections({ budget: 8, attempts: ["3 turns", "8 turns"], verify: "failed", changedPaths: ["a.ts"], progress: "Progress file missing.", worktreePath: dir });
      expect(sections.join("\n")).toContain("Progress file missing.");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("admits only the same dispatcher-owned intact retained worktree", () => {
    const args = { issueId: "MOV-367", repository: "owner/repo", branch: "agent/MOV-367-work", worktreePath: "/tmp/work", dispatcherOwned: true, integrity: { intact: true }, entry: { path: "/tmp/work", branch: "agent/MOV-367-work", status: "failed", provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" } } };
    expect(admitBudgetContinuation(args).admitted).toBe(true);
    expect(admitBudgetContinuation({ ...args, dispatcherOwned: false }).admitted).toBe(false);
    expect(admitBudgetContinuation({ ...args, integrity: { intact: false, reason: "branch moved" } }).reason).toContain("branch moved");
  });
});
