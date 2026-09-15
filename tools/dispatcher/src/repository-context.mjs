// Trusted, bounded repository context for a worker brief.
//
// This is deliberately computed by the dispatcher before it starts the
// sandboxed worker. It gives a worker the orientation it normally seeks from
// `git status`/`git log`, without granting it a Git executable or access to
// mutable repository metadata.

import { execFileSync } from "node:child_process";

export const MAX_RECENT_COMMITS = 12;
export const MAX_CHANGED_PATHS = 40;
const CREDENTIAL_VALUE_RE = /((?:token|secret|password|api[_-]?key|private[_-]?key)\s*[=:]\s*)[^\s,;]+/gi;

function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

function boundedLines(value, max) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((line) => line.replace(CREDENTIAL_VALUE_RE, "$1[REDACTED]"));
}

function read(runner, worktreePath, args, fallback = null) {
  try {
    return String(runner("git", args, { cwd: worktreePath })).trim();
  } catch {
    return fallback;
  }
}

/**
 * Collect only deterministic, read-only Git facts the worker commonly needs
 * for initial orientation. Individual unavailable values remain explicit so a
 * worker never mistakes a missing fact for a permission grant to invoke Git.
 */
export function collectRepositoryContext({ worktreePath, branch, baseRef = "origin/master", runner = defaultRunner } = {}) {
  const headSha = read(runner, worktreePath, ["rev-parse", "HEAD"]);
  const baseSha = read(runner, worktreePath, ["rev-parse", baseRef]);
  const statusLines = boundedLines(read(runner, worktreePath, ["status", "--porcelain=v1"], ""), MAX_CHANGED_PATHS);
  const recentCommits = boundedLines(read(runner, worktreePath, ["log", "--format=%h %s", "-n", String(MAX_RECENT_COMMITS)], ""), MAX_RECENT_COMMITS);
  const changedPaths = boundedLines(read(runner, worktreePath, ["diff", "--name-only", `${baseRef}...HEAD`], ""), MAX_CHANGED_PATHS);

  return {
    branch: branch || read(runner, worktreePath, ["branch", "--show-current"]),
    headSha,
    baseRef,
    baseSha,
    clean: statusLines.length === 0,
    statusLines,
    recentCommits,
    changedPaths,
  };
}
