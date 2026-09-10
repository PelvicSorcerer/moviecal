// Shared technical safety boundary for dispatcher-spawned Claude and Codex
// workers (MOV-145).
//
// Prompts are not an authority boundary. Both worker adapters run inside the
// same macOS sandbox profile, with Git and privileged credentials removed
// from their capability set. Each harness additionally sandboxes every
// model-generated command from the network. After a worker exits, the
// dispatcher audits its structured tool transcript and resulting diff before
// it performs any Git or remote action.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { classifyAction } from "./security-policy.mjs";

export const WORKER_MODES = Object.freeze(["implementation", "repair"]);
export const APPROVED_EXECUTOR = "moviecal-dispatcher";

const ALWAYS_PROTECTED = [
  "AGENTS.md",
  ".github/copilot-instructions.md",
  ".github/workflows/",
  ".claude/",
  ".codex/",
  "docs/product/",
];

const REPAIR_PROTECTED = [
  ...ALWAYS_PROTECTED,
  "docs/governance/",
  "docs/operators/",
  "docs/planning/",
  "tools/dispatcher/",
  "scripts/lane-review.mjs",
  "package.json",
  "package-lock.json",
  "test/",
  "tests/",
  "e2e/",
  "playwright.config.ts",
  "vitest.config.ts",
  "vitest.unit.config.ts",
  "vitest.integration.config.ts",
  "vitest.real-stack.config.ts",
];

const CREDENTIAL_ENV_RE = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASS|KEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|SESSION)(?:_|$)/i;
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "NODE_OPTIONS",
  "CI",
]);

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function isProtected(filePath, mode) {
  const normalized = normalizePath(filePath);
  const prefixes = mode === "repair" ? REPAIR_PROTECTED : ALWAYS_PROTECTED;
  return prefixes.some((candidate) =>
    candidate.endsWith("/") ? normalized.startsWith(candidate) : normalized === candidate,
  );
}

/** Remove credentials that a model-generated child process must never inherit. */
export function sanitizedWorkerEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    if (ENV_ALLOWLIST.has(key) || !CREDENTIAL_ENV_RE.test(key)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/usr/bin/false";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_SSH_COMMAND = "/usr/bin/ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o BatchMode=yes";
  env.GH_CONFIG_DIR = path.join(os.tmpdir(), "moviecal-worker-no-gh-auth");
  delete env.SSH_AUTH_SOCK;
  return env;
}

function quoteSandboxString(value) {
  return `\"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\"`;
}

/**
 * Build the common macOS Seatbelt policy inherited by the worker and every
 * tool it launches. Deny rules win over allow rules, so alternate executables
 * and prompt instructions cannot grant the prohibited capabilities back.
 */
export function buildWorkerSandboxProfile({
  worktreePath,
  mode = "implementation",
  home = os.homedir(),
  logDir,
  protectedRepositoryPaths = [],
  gitMetadataPaths = [],
} = {}) {
  if (!path.isAbsolute(worktreePath || "")) throw new Error("worker sandbox requires an absolute worktreePath");
  if (!WORKER_MODES.includes(mode)) throw new Error(`unknown worker mode: ${mode}`);

  const deniedExecutables = [
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "/usr/local/bin/gh",
    "/opt/homebrew/bin/gh",
    "/usr/bin/ssh",
    "/usr/bin/scp",
    "/usr/bin/sftp",
    "/usr/bin/curl",
    "/usr/bin/security",
    "/usr/local/bin/vercel",
    "/opt/homebrew/bin/vercel",
  ];
  const deniedReads = [
    path.join(home, ".config", "gh"),
    path.join(home, ".config", "moviecal", "linear.env"),
    path.join(home, ".config", "moviecal", "linear-app.env"),
    path.join(home, ".config", "moviecal", "worktrees.json"),
    path.join(home, ".config", "moviecal", "dispatcher.lock"),
    path.join(home, ".ssh"),
    path.join(home, ".git-credentials"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
  ];
  if (mode === "repair") deniedReads.push(path.join(home, ".config", "moviecal", "env.local"));
  if (logDir) deniedReads.push(logDir);
  deniedReads.push(...protectedRepositoryPaths);
  const writeRules = [
    ["literal", path.join(worktreePath, ".git")],
    ["literal", path.join(worktreePath, "AGENTS.md")],
    ["literal", path.join(worktreePath, ".github", "copilot-instructions.md")],
    ["subpath", path.join(worktreePath, ".github", "workflows")],
    ["subpath", path.join(worktreePath, ".claude")],
    ["subpath", path.join(worktreePath, ".codex")],
    ["subpath", path.join(worktreePath, "docs", "product")],
    ["subpath", path.join(home, ".config", "gh")],
    ["subpath", path.join(home, ".config", "moviecal")],
    ["subpath", path.join(home, ".ssh")],
    ["literal", path.join(home, ".gitconfig")],
    ["literal", path.join(home, ".claude", "settings.json")],
    ["literal", path.join(home, ".claude", "settings.local.json")],
    ["literal", path.join(home, ".codex", "config.toml")],
    ["subpath", path.join(home, ".codex", "rules")],
    ["subpath", path.join(home, "Library", "LaunchAgents")],
  ];
  if (logDir) writeRules.push(["subpath", logDir]);
  for (const repositoryPath of protectedRepositoryPaths) writeRules.push(["subpath", repositoryPath]);
  for (const metadataPath of gitMetadataPaths) writeRules.push(["subpath", metadataPath]);
  if (mode === "repair") {
    for (const rel of [
      ["docs", "governance"],
      ["docs", "operators"],
      ["docs", "planning"],
      ["tools", "dispatcher"],
      ["test"],
      ["tests"],
      ["e2e"],
    ]) writeRules.push(["subpath", path.join(worktreePath, ...rel)]);
    for (const rel of [
      ["scripts", "lane-review.mjs"],
      ["package.json"],
      ["package-lock.json"],
      ["playwright.config.ts"],
      ["vitest.config.ts"],
      ["vitest.unit.config.ts"],
      ["vitest.integration.config.ts"],
      ["vitest.real-stack.config.ts"],
    ]) writeRules.push(["literal", path.join(worktreePath, ...rel)]);
  }

  return [
    "(version 1)",
    "(allow default)",
    ...deniedExecutables.map((file) => `(deny process-exec (literal ${quoteSandboxString(file)}))`),
    ...deniedReads.map((file) => `(deny file-read* (subpath ${quoteSandboxString(file)}))`),
    ...writeRules.map(([kind, file]) => `(deny file-write* (${kind} ${quoteSandboxString(file)}))`),
    "",
  ].join("\n");
}

/** Wrap one adapter invocation in the shared OS-enforced sandbox. */
export function guardedInvocation(invocation, { profilePath } = {}) {
  if (!path.isAbsolute(profilePath || "")) throw new Error("guarded invocation requires an absolute profilePath");
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-f", profilePath, invocation.command, ...invocation.args],
  };
}

function visitToolEvents(value, found) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visitToolEvents(item, found);
    return;
  }

  // Claude stream-json tool call.
  if (value.type === "tool_use" && typeof value.name === "string") {
    const input = value.input || {};
    if (value.name === "Bash" && typeof input.command === "string") {
      found.push({ kind: "command", value: input.command });
    }
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(value.name)) {
      for (const key of ["file_path", "path", "notebook_path"]) {
        if (typeof input[key] === "string") found.push({ kind: "path", value: input[key] });
      }
    }
  }

  // Codex --json command_execution/file_change items.
  if (value.type === "command_execution" && typeof value.command === "string") {
    found.push({ kind: "command", value: value.command });
  }
  if (value.type === "file_change") {
    for (const change of value.changes || []) {
      if (typeof change?.path === "string") found.push({ kind: "path", value: change.path });
    }
  }

  for (const child of Object.values(value)) visitToolEvents(child, found);
}

export function extractToolActions(jsonl) {
  const found = [];
  for (const line of String(jsonl || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      visitToolEvents(JSON.parse(line), found);
    } catch {
      // Non-JSON diagnostics are not treated as tool calls. The adapters are
      // launched in structured-output mode; malformed output is recorded by
      // the audit as a separate fail-closed condition below.
    }
  }
  return found;
}

export function auditWorkerTranscript(jsonl, { mode = "implementation" } = {}) {
  const actions = extractToolActions(jsonl);
  const violations = [];
  const lines = String(jsonl || "").split("\n").filter((line) => line.trim());
  if (lines.length === 0) {
    violations.push({ action: "stdout.log", reason: "structured worker transcript is empty" });
  }
  lines.forEach((line, index) => {
    try {
      JSON.parse(line);
    } catch {
      violations.push({ action: `stdout.log:${index + 1}`, reason: "malformed structured worker event" });
    }
  });
  for (const action of actions) {
    if (action.kind === "path" && isProtected(action.value, mode)) {
      violations.push({ action: action.value, reason: `attempted to modify protected ${mode} path` });
      continue;
    }
    if (action.kind === "command") {
      const classified = classifyAction(action.value, { workerMode: mode });
      if (classified.verdict !== "allow") {
        violations.push({ action: action.value, reason: classified.reason });
      }
    }
  }
  return { ok: violations.length === 0, actions, violations };
}

export function auditChangedPaths(paths, { mode = "implementation" } = {}) {
  const violations = [...new Set(paths.map(normalizePath).filter(Boolean))]
    .filter((file) => isProtected(file, mode))
    .map((file) => ({ action: file, reason: `protected ${mode} path changed` }));
  return { ok: violations.length === 0, violations };
}

function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

/** Resolve every sibling checkout and backing Git directory before entering the sandbox. */
export function repositoryGuardPaths(worktreePath, runner = defaultRunner) {
  const worktrees = String(runner("git", ["worktree", "list", "--porcelain"], { cwd: worktreePath }))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  const current = path.resolve(worktreePath);
  const gitMetadataPaths = [
    String(runner("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: worktreePath })).trim(),
    String(runner("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktreePath })).trim(),
  ].filter(Boolean).map((value) => path.resolve(value));
  return {
    protectedRepositoryPaths: [...new Set(worktrees.filter((value) => value !== current))],
    gitMetadataPaths: [...new Set(gitMetadataPaths)],
  };
}

function statusPaths(output) {
  return String(output || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => file.includes(" -> ") ? file.split(" -> ").at(-1) : file);
}

/** Audit the actual branch, transcript, base diff, and dirty paths. */
export function auditWorkerResult({ worktreePath, branch, logDir, mode = "implementation", runner = defaultRunner, fsImpl = fs } = {}) {
  const violations = [];
  const actualBranch = String(runner("git", ["branch", "--show-current"], { cwd: worktreePath })).trim();
  if (actualBranch !== branch) {
    violations.push({ action: actualBranch || "detached HEAD", reason: `worker left assigned branch ${branch}` });
  }
  const committed = String(runner("git", ["diff", "--name-only", "origin/master...HEAD"], { cwd: worktreePath })).split("\n").filter(Boolean);
  const dirty = statusPaths(runner("git", ["status", "--porcelain=v1"], { cwd: worktreePath }));
  const changedAudit = auditChangedPaths([...committed, ...dirty], { mode });
  violations.push(...changedAudit.violations);

  const stdoutPath = path.join(logDir, "stdout.log");
  if (!fsImpl.existsSync(stdoutPath)) {
    violations.push({ action: stdoutPath, reason: "structured worker transcript is missing" });
  } else {
    const transcript = auditWorkerTranscript(fsImpl.readFileSync(stdoutPath, "utf8"), { mode });
    violations.push(...transcript.violations);
  }
  return { ok: violations.length === 0, mode, branch, actualBranch, committed, dirty, violations };
}

/** Persist an audit record outside the worker-writable worktree. */
export function writeWorkerAudit(logDir, report, { fsImpl = fs, now = () => new Date() } = {}) {
  fsImpl.mkdirSync(logDir, { recursive: true });
  const createdAt = now().toISOString();
  const payload = { version: 1, createdAt, ...report };
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const record = { ...payload, sha256: digest };
  const auditPath = path.join(logDir, "security-audit.json");
  fsImpl.writeFileSync(auditPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return { path: auditPath, sha256: digest };
}

/**
 * Admission control for MOV-149/MOV-151 repair jobs. The registry is outside
 * the worktree and is the authority that a branch was created by this
 * dispatcher. A fork, unknown branch, stale SHA, or legacy unprovenanced
 * record is never repairable automatically.
 */
export function validateRepairTarget({ entry, observation, repository } = {}) {
  const reasons = [];
  if (!entry || typeof entry !== "object") reasons.push("branch is not present in the dispatcher worktree registry");
  if (entry && entry.status !== "review") reasons.push("worktree is not retained in review state");
  if (entry?.provenance?.executor !== APPROVED_EXECUTOR) reasons.push("worktree lacks approved-executor provenance");
  if (entry?.provenance?.repository !== repository) reasons.push("worktree provenance does not match the configured repository");
  if (!observation || typeof observation !== "object") reasons.push("PR observation is missing");
  if (observation?.headRepository !== repository) reasons.push("fork PRs are not eligible for repair");
  if (entry?.branch && observation?.headBranch !== entry.branch) reasons.push("PR head branch does not match the retained worktree");
  if (!entry?.branch?.startsWith(`agent/${entry.id}-`)) reasons.push("branch does not match the dispatcher issue namespace");
  if (entry?.headSha && observation?.headSha !== entry.headSha) reasons.push("PR head SHA changed after the trusted observation");
  return { ok: reasons.length === 0, reasons };
}
