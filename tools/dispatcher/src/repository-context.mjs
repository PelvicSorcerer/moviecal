// Trusted, bounded repository context for a worker brief.
//
// This is deliberately computed by the dispatcher before it starts the
// sandboxed worker. It gives a worker the orientation it normally seeks from
// `git status`/`git log`, without granting it a Git executable or access to
// mutable repository metadata.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MAX_RECENT_COMMITS = 12;
export const MAX_CHANGED_PATHS = 40;
export const MAX_STARTING_POINTS = 15;
export const LARGE_FILE_LINES = 400;
const CREDENTIAL_VALUE_RE = /((?:token|secret|password|api[_-]?key|private[_-]?key)\s*[=:]\s*)[^\s,;]+/gi;
const MAX_ORIENTATION_BYTES = 2 * 1024 * 1024;

function redact(value) {
  return String(value).replace(CREDENTIAL_VALUE_RE, "$1[REDACTED]");
}

/** Extract plausible repository-relative file paths, never arbitrary issue prose. */
export function issuePathCandidates(description) {
  const found = new Set();
  for (const match of String(description || "").matchAll(/(?:^|[\s`"'(])((?:[\w@.=-]+\/)*[\w@.=-]+\.[\w-]+)(?=$|[\s`"'),.:;!?])/gm)) {
    const candidate = match[1];
    if (candidate.startsWith(".") && !candidate.startsWith(".github/") && !candidate.startsWith(".claude/")) continue;
    if (candidate.split("/").some((part) => part === ".." || part === ".")) continue;
    found.add(candidate);
  }
  return [...found];
}

/** Best-effort orientation only: a missing or unreadable file yields no entry. */
export function collectLikelyStartingPoints({ worktreePath, description, fsApi = fs } = {}) {
  try {
    if (!worktreePath) return [];
    const root = fsApi.realpathSync(worktreePath);
    const points = [];
    for (const candidate of issuePathCandidates(description)) {
      if (points.length >= MAX_STARTING_POINTS) break;
      try {
        const file = path.resolve(root, candidate);
        if (!file.startsWith(`${root}${path.sep}`)) continue;
        const actual = fsApi.realpathSync(file);
        if (!actual.startsWith(`${root}${path.sep}`)) continue;
        const stat = fsApi.statSync(actual);
        if (!stat.isFile() || stat.size > MAX_ORIENTATION_BYTES) continue;
        const content = fsApi.readFileSync(actual, "utf8");
        if (content.includes("\0")) continue;
        const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
        points.push({ path: redact(candidate), lines, readByRange: lines > LARGE_FILE_LINES });
      } catch { /* one path should not suppress another */ }
    }
    return points;
  } catch {
    return [];
  }
}

function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

function boundedLines(value, max) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, max)
    .map(redact);
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
export function collectRepositoryContext({ worktreePath, branch, baseRef = "origin/master", issueDescription = "", runner = defaultRunner } = {}) {
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
    likelyStartingPoints: collectLikelyStartingPoints({ worktreePath, description: issueDescription }),
  };
}
