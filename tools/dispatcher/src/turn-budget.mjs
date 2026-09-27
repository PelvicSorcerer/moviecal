import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { redactWorkerOutput } from "./worker-spawn.mjs";
import { budgetUnitForWorker, wrapUpPossible } from "./budget-unit.mjs";

export const PROGRESS_FILE = "WORKER_PROGRESS.md";
const DEFAULTS = { cheap: 60, default: 150, strong: 250 };

export function turnBudgetForTier(tier, env = process.env) {
  if (!Object.hasOwn(DEFAULTS, tier)) throw new Error(`unknown model tier: ${tier}`);
  const key = `MOVIECAL_TURN_BUDGET_${tier.toUpperCase()}`;
  const raw = env[key];
  if (raw === undefined) return DEFAULTS[tier];
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`invalid ${key}: expected a positive safe integer`);
  }
  return Number(raw);
}

// MOV-387: Codex counts completed work items, not turns. UNMEASURED starting
// values: no real Codex `--json` export was available to the authoring worker,
// so these are not yet 3x the per-tier median. Recalibrate from MOV-382 exports.
const CODEX_DEFAULTS = { cheap: 60, default: 150, strong: 300 };

export function codexItemBudgetForTier(tier, env = process.env) {
  if (!Object.hasOwn(CODEX_DEFAULTS, tier)) throw new Error(`unknown model tier: ${tier}`);
  const key = `MOVIECAL_CODEX_TURN_BUDGET_${tier.toUpperCase()}`;
  const raw = env[key];
  if (raw === undefined) return CODEX_DEFAULTS[tier];
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`invalid ${key}: expected a positive safe integer`);
  }
  return Number(raw);
}

/** Budget for a worker's own unit; only that worker's overrides are validated. */
export function budgetForWorker(worker, tier, env = process.env) {
  return worker === "codex" ? codexItemBudgetForTier(tier, env) : turnBudgetForTier(tier, env);
}

/** Doctor view of one worker's budget: unit, per-tier limits, and whether a wrap-up prompt is possible. */
export function describeWorkerBudget(worker, { env = process.env, steeringEnabled = false } = {}) {
  const unit = budgetUnitForWorker(worker);
  const wrapUp = wrapUpPossible(worker, steeringEnabled)
    ? "wrap-up possible (steering on)"
    : worker === "claude" ? "no wrap-up (steering off)" : "no wrap-up (no steering channel)";
  try {
    const limits = ["cheap", "default", "strong"].map((tier) => `${tier}=${budgetForWorker(worker, tier, env)}`).join(", ");
    return { ok: true, detail: `unit ${unit}; limits ${limits}; ${wrapUp}` };
  } catch (error) {
    return { ok: false, detail: `unit ${unit}; ${error.message}` };
  }
}

export function wrapUpAt(budget) {
  return Math.ceil(budget * 0.85);
}

export const WRAP_UP_PROMPT = "Turn budget is nearly exhausted. Stop exploring. Leave the worktree consistent, then write WORKER_PROGRESS.md with what is done, what remains, and the next concrete step. Do not commit or publish. Finish promptly.";

export function readWorkerProgress(worktreePath, { maxBytes = 4096 } = {}) {
  const file = path.join(worktreePath, PROGRESS_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return "Progress file unavailable (not a regular file).";
    const fd = fs.openSync(file, "r");
    try {
      const bytes = Buffer.alloc(maxBytes + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const excerpt = redactWorkerOutput(bytes.subarray(0, Math.min(length, maxBytes)).toString("utf8"))
        .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/```/g, "''' ");
      return excerpt + (length > maxBytes || stat.size > maxBytes ? "\n[truncated]" : "");
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code === "ENOENT") return "Progress file missing.";
    return "Progress file unavailable.";
  }
}

export function hasWorkerProgress(worktreePath) {
  try { return fs.lstatSync(path.join(worktreePath, PROGRESS_FILE)).isFile(); } catch { return false; }
}

export function removeWorkerProgress(worktreePath) {
  const file = path.join(worktreePath, PROGRESS_FILE);
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export function diffSummary(worktreePath, { runner = execFileSync } = {}) {
  const options = { cwd: worktreePath, encoding: "utf8" };
  const stat = String(runner("git", ["diff", "--stat", "origin/master"], options)).slice(0, 3000);
  const status = String(runner("git", ["status", "--short"], options)).slice(0, 2000);
  return redactWorkerOutput(`${stat}\nChanged paths:\n${status}`.trim()).replace(/```/g, "''' ");
}

export const NO_STEERING_CONTINUATION_NOTE = "This worker could not be sent a wrap-up prompt, so no progress file may exist. Rely on the diff summary and the worktree contents.";

export function budgetHandoffSections({ budget, unit = "claude-assistant-turns", attempts, verify, changedPaths, progress, worktreePath }) {
  return [
    `Turn budget: ${budget} (unit: ${unit}); ${attempts.length} attempt(s). The retained worktree was not published.`,
    ...attempts.map((usage, index) => `Attempt ${index + 1}: ${usage || "usage unavailable"}`),
    `Latest exact verify: ${verify || "unavailable"}`,
    `Changed files: ${changedPaths.length ? redactWorkerOutput(changedPaths.slice(0, 60).join(", ")).replace(/```/g, "''' ").slice(0, 3000) : "none"}`,
    "Progress excerpt:",
    "```text",
    progress,
    "```",
    `Retained worktree: \`${worktreePath}\``,
  ];
}
