import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { redactWorkerOutput } from "./worker-spawn.mjs";

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

export function budgetHandoffSections({ budget, attempts, verify, changedPaths, progress, worktreePath }) {
  return [
    `Turn budget: ${budget}; ${attempts.length} attempt(s). The retained worktree was not published.`,
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
