import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { budgetForWorker, budgetHandoffSections, codexItemBudgetForTier, describeWorkerBudget, readWorkerProgress, turnBudgetForTier, wrapUpAt } from "../src/turn-budget.mjs";
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
  });

  it("counts Codex completed work items, not the single turn.completed", () => {
    const item = (type, phase = "item.completed") => JSON.stringify({ type: phase, item: { type } }) + "\n";
    const codex = [];
    const count = makeAssistantTurnCounter("codex", (n) => codex.push(n));
    count(Buffer.from(
      item("command_execution", "item.started") + item("command_execution") + item("reasoning") + item("file_change") +
      "not json\n{broken\n" + item("mcp_tool_call") + item("agent_message") + '{"type":"turn.completed"}\n',
    ));
    expect(codex).toEqual([1, 2, 3, 4]);
    const single = [];
    makeAssistantTurnCounter("codex", (n) => single.push(n))('{"type":"turn.completed"}\n');
    expect(single).toEqual([]);
  });

  it("parses Codex budgets, fails loudly on invalid values, and reports units in doctor", () => {
    expect(codexItemBudgetForTier("default", {})).toBe(150);
    expect(codexItemBudgetForTier("cheap", { MOVIECAL_CODEX_TURN_BUDGET_CHEAP: "12" })).toBe(12);
    expect(budgetForWorker("claude", "default", { MOVIECAL_CODEX_TURN_BUDGET_DEFAULT: "1" })).toBe(150);
    for (const invalid of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => codexItemBudgetForTier("strong", { MOVIECAL_CODEX_TURN_BUDGET_STRONG: invalid })).toThrow(/invalid MOVIECAL_CODEX_TURN_BUDGET_STRONG/);
    }
    expect(() => workerInvocation("codex", "default", {})).not.toThrow();
    const codex = describeWorkerBudget("codex", { env: {}, steeringEnabled: true });
    expect(codex).toMatchObject({ ok: true });
    expect(codex.detail).toContain("codex-items");
    expect(codex.detail).toContain("no wrap-up (no steering channel)");
    expect(describeWorkerBudget("claude", { env: {}, steeringEnabled: true }).detail).toContain("wrap-up possible");
    expect(describeWorkerBudget("claude", { env: {}, steeringEnabled: false }).detail).toContain("claude-assistant-turns");
    expect(describeWorkerBudget("codex", { env: { MOVIECAL_CODEX_TURN_BUDGET_DEFAULT: "x" } }).ok).toBe(false);
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
      const sections = budgetHandoffSections({ budget: 8, attempts: ["3 turns", "8 turns"], verify: "failed", changedPaths: ["a.ts"], progress: "Progress file missing.", worktreePath: dir, unit: "codex-items" });
      expect(sections.join("\n")).toContain("Progress file missing.");
      expect(sections[0]).toContain("unit: codex-items");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("admits only the same dispatcher-owned intact retained worktree", () => {
    const args = { issueId: "MOV-367", repository: "owner/repo", branch: "agent/MOV-367-work", worktreePath: "/tmp/work", dispatcherOwned: true, integrity: { intact: true }, entry: { path: "/tmp/work", branch: "agent/MOV-367-work", status: "failed", provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" } } };
    expect(admitBudgetContinuation(args).admitted).toBe(true);
    expect(admitBudgetContinuation({ ...args, dispatcherOwned: false }).admitted).toBe(false);
    expect(admitBudgetContinuation({ ...args, integrity: { intact: false, reason: "branch moved" } }).reason).toContain("branch moved");
  });
});
