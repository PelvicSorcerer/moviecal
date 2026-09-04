#!/usr/bin/env node
// moviecal-dispatcher CLI.
//
// Usage:
//   dispatcher doctor    - read-only health check of every dependency
//   dispatcher dry-run   - fetch Ready-for-Agent issues and print the plan
//                          without touching any worktree, branch, or Linear
//                          state (safe to run with a live or missing key)
//   dispatcher gc        - prune merged/stale worktrees and old run logs
//   dispatcher run       - the real poll loop (not yet wired to a live
//                          Linear workspace as of this scaffold)
//
// See docs/operators/local-execution.md.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  configDir,
  envLocalPath,
  linearEnvPath,
  worktreeRoot,
  logRoot,
  worktreesStatePath,
  loadLinearConfig,
  checkSecretFileMode,
  DEFAULT_CONCURRENCY,
  RUN_LOG_RETENTION_DAYS,
  REPO_ROOT,
} from "../src/config.mjs";
import { LinearClient } from "../src/linear-client.mjs";
import { evaluatePreflight, worktreeName, branchName } from "../src/preflight.mjs";
import { resolveRouting } from "../src/worker-routing.mjs";
import { WorktreeManager } from "../src/worktree-manager.mjs";

const IOS_RUNNER_NAME = "moviecal-ios-runner";
const GITHUB_REPO = "PelvicSorcerer/moviecal";

function tryRun(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cmdDoctor() {
  const checks = [];

  // Linear auth
  const linearConfig = loadLinearConfig();
  if (!linearConfig.apiKey) {
    checks.push({ name: "Linear API key", ok: false, detail: `not found at ${linearEnvPath()} or $LINEAR_API_KEY` });
  } else {
    const client = new LinearClient({ apiKey: linearConfig.apiKey });
    const result = await tryRunAsync(() => client.viewer());
    checks.push({
      name: "Linear API auth",
      ok: result.ok,
      detail: result.ok ? `authenticated as ${result.value.name}` : result.error,
    });
  }

  // gh auth
  const ghAuth = tryRun(() => execFileSync("gh", ["auth", "status"], { encoding: "utf8" }));
  checks.push({ name: "gh CLI auth", ok: ghAuth.ok, detail: ghAuth.ok ? "authenticated" : ghAuth.error });

  // worktree root writable
  const root = worktreeRoot();
  const rootCheck = tryRun(() => {
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
  });
  checks.push({ name: "worktree root writable", ok: rootCheck.ok, detail: rootCheck.ok ? root : rootCheck.error });

  // env.local present and mode 600
  const envCheck = checkSecretFileMode(envLocalPath());
  checks.push({ name: ".env.local present + mode 600", ok: envCheck.ok, detail: envCheck.reason || envLocalPath() });

  // claude / codex on PATH
  for (const bin of ["claude", "codex"]) {
    const which = tryRun(() => execFileSync("which", [bin], { encoding: "utf8" }).trim());
    checks.push({ name: `${bin} on PATH`, ok: which.ok, detail: which.ok ? which.value : `not found (required for the ${bin} worker adapter)` });
  }

  // origin/master fetchable
  const fetchCheck = tryRun(() => execFileSync("git", ["fetch", "origin", "master"], { cwd: REPO_ROOT, encoding: "utf8" }));
  checks.push({ name: "origin/master fetchable", ok: fetchCheck.ok, detail: fetchCheck.ok ? "ok" : fetchCheck.error });

  // iOS runner reachable
  const runnerCheck = tryRun(() => {
    const out = execFileSync(
      "gh",
      ["api", `repos/${GITHUB_REPO}/actions/runners`],
      { encoding: "utf8" },
    );
    const runners = JSON.parse(out).runners || [];
    const runner = runners.find((r) => r.name === IOS_RUNNER_NAME);
    if (!runner) throw new Error(`runner '${IOS_RUNNER_NAME}' not registered`);
    if (runner.status !== "online") throw new Error(`runner '${IOS_RUNNER_NAME}' is ${runner.status}`);
    return runner;
  });
  checks.push({
    name: "iOS self-hosted runner online",
    ok: runnerCheck.ok,
    detail: runnerCheck.ok ? `${IOS_RUNNER_NAME} online` : runnerCheck.error,
  });

  printChecks(checks);
  return checks.every((c) => c.ok) ? 0 : 1;
}

async function tryRunAsync(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function printChecks(checks) {
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    console.log(`${mark} ${c.name}: ${c.detail}`);
  }
}

async function cmdDryRun({ fixturePath } = {}) {
  let issues;
  if (fixturePath) {
    issues = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  } else {
    const linearConfig = loadLinearConfig();
    if (!linearConfig.apiKey) {
      console.error(`No Linear API key configured (${linearEnvPath()}) and no --fixture given. Nothing to dry-run.`);
      return 1;
    }
    const client = new LinearClient({ apiKey: linearConfig.apiKey });
    issues = await client.issuesInState({ teamKey: linearConfig.teamKey, stateName: "Ready for Agent" });
  }

  const manager = new WorktreeManager({
    repoRoot: REPO_ROOT,
    worktreeRoot: worktreeRoot(),
    statePath: worktreesStatePath(),
  });
  const activeWorktreeCount = tryRun(() => manager.activeCount());

  console.log(`${issues.length} issue(s) in Ready for Agent:\n`);
  for (const issue of issues) {
    const routing = resolveRouting(issue);
    const name = worktreeName(issue.identifier, issue.title);
    const branch = branchName(issue.identifier, issue.title);
    const context = {
      isIssueSatisfied: () => true, // dry-run: relation resolution needs live Linear state; assume satisfied for the plan preview
      iosRunnerOnline: true, // dry-run: does not hit the network; use `doctor` for the live check
      activeWorktreeCount: activeWorktreeCount.ok ? activeWorktreeCount.value : 0,
      concurrencyLimit: DEFAULT_CONCURRENCY,
      secretPresent: () => fs.existsSync(envLocalPath()),
      worktreePathFree: (p) => manager.isPathFree(p),
      candidateWorktreePath: path.join(worktreeRoot(), name),
    };
    const preflight = evaluatePreflight(issue, context);

    console.log(`- ${issue.identifier}: ${issue.title}`);
    console.log(`  worktree: ${path.join(worktreeRoot(), name)}`);
    console.log(`  branch:   ${branch}`);
    console.log(`  worker:   ${routing.worker} (model: ${routing.model})${routing.ok ? "" : `  [ROUTING BLOCKED: ${routing.reason}]`}`);
    console.log(`  preflight: ${preflight.ok ? "PASS" : `BLOCKED — ${preflight.reason}`}`);
    console.log("");
  }
  console.log("Dry run only — no worktree, branch, or Linear state was changed.");
  return 0;
}

function cmdGc() {
  const manager = new WorktreeManager({
    repoRoot: REPO_ROOT,
    worktreeRoot: worktreeRoot(),
    statePath: worktreesStatePath(),
  });
  const removed = manager.gc({ retentionDays: 7 });
  console.log(removed.length > 0 ? `Pruned: ${removed.join(", ")}` : "Nothing to prune.");

  const logDir = logRoot();
  if (fs.existsSync(logDir)) {
    const now = Date.now();
    const cutoffMs = RUN_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(logDir)) {
      const full = path.join(logDir, entry);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > cutoffMs) {
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`Pruned run log: ${entry}`);
      }
    }
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "doctor":
      process.exitCode = await cmdDoctor();
      break;
    case "dry-run": {
      const fixtureFlagIdx = rest.indexOf("--fixture");
      const fixturePath = fixtureFlagIdx !== -1 ? rest[fixtureFlagIdx + 1] : undefined;
      process.exitCode = await cmdDryRun({ fixturePath });
      break;
    }
    case "gc":
      cmdGc();
      break;
    case "run":
      console.error(
        "`dispatcher run` (the live poll loop) is not yet wired up — this scaffold ships doctor/dry-run/gc first. See docs/operators/local-execution.md 'Known gaps / follow-ups'.",
      );
      process.exitCode = 1;
      break;
    default:
      console.error("Usage: dispatcher <doctor|dry-run|gc|run> [--fixture <path>]");
      process.exitCode = 1;
  }
}

main();
