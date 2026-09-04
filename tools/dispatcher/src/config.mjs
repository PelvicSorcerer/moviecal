// Dispatcher configuration and paths.
//
// All runtime configuration lives outside the repository, under
// ~/.config/moviecal/ (mode 700). Nothing here should ever read a
// credential from the repo itself. See docs/operators/local-execution.md.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
);

export function configDir() {
  return path.join(os.homedir(), ".config", "moviecal");
}

export function linearEnvPath() {
  return path.join(configDir(), "linear.env");
}

export function envLocalPath() {
  return path.join(configDir(), "env.local");
}

export function worktreesStatePath() {
  return path.join(configDir(), "worktrees.json");
}

export function worktreeRoot() {
  return process.env.MOVIECAL_WORKTREE_ROOT || path.join(os.homedir(), "code", "worktrees", "moviecal");
}

export function logRoot() {
  return process.env.MOVIECAL_LOG_ROOT || path.join(os.homedir(), "Library", "Logs", "moviecal-dispatcher");
}

export const DEFAULT_CONCURRENCY = 2;
export const RUN_LOG_RETENTION_DAYS = 90;
export const FAILED_WORKTREE_RETENTION_DAYS = 7;

/** Parse a simple KEY=VALUE dotenv-style file. Returns {} if the file is missing. */
export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Check a path is present and mode-600 (or stricter). Returns {ok, reason}. */
export function checkSecretFileMode(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `missing: ${filePath}` };
  }
  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode & 0o077) {
    return { ok: false, reason: `${filePath} is mode ${mode.toString(8)}, expected 600 or stricter (group/other must have no access)` };
  }
  return { ok: true, reason: null };
}

export function loadLinearConfig() {
  const env = parseEnvFile(linearEnvPath());
  return {
    apiKey: env.LINEAR_API_KEY || process.env.LINEAR_API_KEY || null,
    teamKey: env.LINEAR_TEAM_KEY || process.env.LINEAR_TEAM_KEY || "MOV",
  };
}
