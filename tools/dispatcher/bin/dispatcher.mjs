#!/usr/bin/env node
// moviecal-dispatcher CLI.
//
// Usage:
//   dispatcher doctor              - read-only health check of every dependency
//   dispatcher dry-run             - fetch Ready-for-Agent issues and print the plan
//                                     without touching any worktree, branch, or Linear
//                                     state (safe to run with a live or missing key)
//   dispatcher gc                  - prune merged/stale worktrees and old run logs
//   dispatcher promote [--dry-run] - move Backlog/Blocked issues that meet the
//                                     readiness contract into Ready for Agent
//                                     (MOV-129); the run loop does this each cycle
//   dispatcher run --once          - process every currently-eligible Ready-for-Agent
//                                     issue exactly once, then exit (real side effects:
//                                     creates worktrees, spawns workers, opens PRs)
//   dispatcher run [--interval ms] - the live poll loop (default 30s); same real side
//                                     effects as --once, repeated forever
//
// See docs/operators/local-execution.md.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  configDir,
  envLocalPath,
  linearEnvPath,
  linearAppEnvPath,
  worktreeRoot,
  logRoot,
  worktreesStatePath,
  loadLinearConfig,
  loadLinearAppConfig,
  resolveLinearAuth,
  resolveDispatcherDelegate,
  checkSecretFileMode,
  DEFAULT_CONCURRENCY,
  DEFAULT_WORKER_TIMEOUT_MS,
  RUN_LOG_RETENTION_DAYS,
  REPO_ROOT,
  dispatcherLockPath,
} from "../src/config.mjs";
import { LinearClient } from "../src/linear-client.mjs";
import { getAppToken } from "../src/linear-app-auth.mjs";
import { evaluatePreflight, worktreeName, branchName } from "../src/preflight.mjs";
import { resolveRouting } from "../src/worker-routing.mjs";
import { inferExecutionRoute, resolveExecutionRoute } from "../src/execution-routing.mjs";
import {
  describeDelegate,
  evaluateLocalDispatch,
  selectCloudCandidates,
} from "../src/dispatch-eligibility.mjs";
import { DispatcherLock, WorktreeManager } from "../src/worktree-manager.mjs";
import { runOnce } from "../src/run-loop.mjs";
import { buildIsIssueSatisfied } from "../src/dependency-gate.mjs";
import { promoteEligible, PROMOTABLE_STATES } from "../src/promoter.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { findPrForBranch, defaultRunner as ghRunner } from "../src/pr-check.mjs";
import { checkPrState, checkPrObservation, reconcileReviewWorktrees } from "../src/pr-reconcile.mjs";
import { decideCiOutcome, formatShadowReport, reportObservationToLinear } from "../src/ci-outcomes.mjs";
import { applyStagedWorkflowEdit } from "../src/workflow-edit-apply.mjs";

const IOS_RUNNER_NAME = "moviecal-ios-runner";
const GITHUB_REPO = "PelvicSorcerer/moviecal";

/**
 * Build the LinearClient the real run/dry-run path authenticates with:
 * prefer the app-actor credential (linear-app.env, MOV-122) when configured,
 * else fall back to the personal API key (linear.env) — see
 * `resolveLinearAuth()` and docs/planning/mov-122-linear-actor-authorization-plan.md.
 * Returns `null` (with a printed error) when neither credential is configured.
 */
function buildLinearClient() {
  const auth = resolveLinearAuth();
  if (auth.mode === "app") return { client: new LinearClient({ appAuth: auth.appAuth }), teamKey: auth.teamKey };
  if (auth.mode === "apiKey") return { client: new LinearClient({ apiKey: auth.apiKey }), teamKey: auth.teamKey };
  console.error(
    `No Linear credential configured (checked ${linearAppEnvPath()} and ${linearEnvPath()}). Run \`dispatcher doctor\` first.`,
  );
  return null;
}

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

  // Linear app-actor credential (MOV-122) — optional during the transition
  const appConfig = loadLinearAppConfig();
  if (!appConfig.clientId && !appConfig.clientSecret) {
    checks.push({
      name: "Linear app-actor credential",
      ok: true,
      detail: `not configured (${linearAppEnvPath()}) — dispatcher uses the personal key; see MOV-122`,
    });
  } else {
    const appModeCheck = checkSecretFileMode(linearAppEnvPath());
    checks.push({
      name: "linear-app.env present + mode 600",
      ok: appModeCheck.ok,
      detail: appModeCheck.reason || linearAppEnvPath(),
    });
    const tokenResult = await tryRunAsync(() =>
      getAppToken({
        clientId: appConfig.clientId,
        clientSecret: appConfig.clientSecret,
        scopes: appConfig.scopes || undefined,
      }),
    );
    checks.push({
      name: "Linear app-actor token mint",
      ok: tokenResult.ok,
      detail: tokenResult.ok
        ? `ok, expires ${tokenResult.value.expiresAt.toISOString().slice(0, 10)}`
        : tokenResult.error,
    });
  }

  // Dispatch identity (MOV-143) — which delegate an issue must name to be claimed here.
  const delegate = resolveDispatcherDelegate();
  checks.push({
    name: "local dispatch identity",
    ok: true,
    detail:
      delegate.id && delegate.id !== delegate.name
        ? `claims issues delegated to "${delegate.name}" or actor id ${delegate.id}`
        : `claims issues delegated to "${delegate.name}" (by name; set LINEAR_APP_ACTOR_ID in ${linearAppEnvPath()} to the actor UUID to also match by id)`,
  });

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
    const built = buildLinearClient();
    if (!built) return 1;
    issues = await built.client.issuesInState({ teamKey: built.teamKey, stateName: "Ready for Agent" });
  }

  const manager = new WorktreeManager({
    repoRoot: REPO_ROOT,
    worktreeRoot: worktreeRoot(),
    statePath: worktreesStatePath(),
  });
  const activeWorktreeCount = tryRun(() => manager.activeCount());

  const dispatcherDelegate = resolveDispatcherDelegate();

  console.log(`${issues.length} issue(s) in Ready for Agent:\n`);
  for (const issue of issues) {
    const routing = resolveRouting(issue);
    const execution = resolveExecutionRoute(issue);
    const eligibility = evaluateLocalDispatch(issue, { expectedDelegate: dispatcherDelegate });
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
    console.log(`  execution: ${execution.ok ? execution.route : `INVALID — ${execution.reason}`} (inferred ${inferExecutionRoute(issue)})`);
    console.log(`  delegate: ${describeDelegate(issue.delegate)}`);
    console.log(
      `  local dispatch: ${eligibility.eligible ? "ELIGIBLE" : `${eligibility.action.toUpperCase()} — ${eligibility.reason}`}`,
    );
    console.log(`  preflight: ${preflight.ok ? "PASS" : `BLOCKED — ${preflight.reason}`}`);
    console.log("");
  }

  // MOV-143: make the adapter split visible, so it is obvious at a glance
  // whether an issue is being declined because it belongs to the (not yet
  // enabled) cloud lane or because its route/delegation is simply wrong.
  const executable = issues.filter((issue) => evaluateLocalDispatch(issue, { expectedDelegate: dispatcherDelegate }).eligible);
  const cloud = selectCloudCandidates(issues);
  console.log(`Executable on this Mac: ${executable.length}/${issues.length}${executable.length ? ` (${executable.map((i) => i.identifier).join(", ")})` : ""}`);
  console.log(
    `Cloud-routed (not executable here; the cloud adapter is not enabled): ${cloud.length}${cloud.length ? ` (${cloud.map((i) => i.identifier).join(", ")})` : ""}`,
  );
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

/**
 * Read-only CI classifier preview. It intentionally accepts a fixture so a
 * real PR payload can be saved and replayed without credentials or writes.
 */
function cmdShadow({ prNumber, fixturePath } = {}) {
  if (!prNumber) {
    console.error("shadow requires --pr <number>");
    return 1;
  }
  let observation;
  if (fixturePath) {
    observation = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  } else {
    observation = checkPrObservation(prNumber, GITHUB_REPO, ghRunner);
  }
  if (observation.observationError) {
    console.log(JSON.stringify({ mode: "shadow", readOnly: true, prNumber, observationError: observation.observationError, wouldStartWorker: false, wouldRerunCi: false, wouldMutateLinear: false }, null, 2));
    return 0;
  }
  const events = (observation.checks?.checks || []).map((check) => ({
    ...check,
    required: check.required,
    sha: check.sha || observation.headSha,
    conclusion: check.outcome,
  }));
  const decision = decideCiOutcome({ prNumber, prUrl: observation.url || null, headSha: observation.headSha, events });
  console.log(formatShadowReport({
    ...decision,
    observation: {
      state: observation.state,
      isDraft: observation.isDraft,
      headSha: observation.headSha,
      requiredChecks: observation.checks.required.map((check) => check.name),
      missingRequired: observation.checks.missingRequired,
    },
  }));
  return 0;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const RUN_STATE_NAMES = {
  readyForAgent: "Ready for Agent",
  blocked: "Blocked",
  agentWorking: "Agent Working",
  needsHumanDecision: "Needs Human Decision",
  inReview: "In Review",
};

async function checkIosRunnerOnline() {
  try {
    const out = execFileSync("gh", ["api", `repos/${GITHUB_REPO}/actions/runners`], { encoding: "utf8" });
    const runner = (JSON.parse(out).runners || []).find((r) => r.name === IOS_RUNNER_NAME);
    return Boolean(runner && runner.status === "online");
  } catch {
    return false;
  }
}

/**
 * Build the real (non-fake) context runOnce needs, wiring actual Linear/gh/git/process
 * dependencies. `issues` is the same "Ready for Agent" batch runOnce will process --
 * each issue's `inverseRelations` (from LinearClient.issuesInState()) already carries
 * its blockers' workflow states, so isIssueSatisfied is resolved from that batch with
 * no extra Linear call.
 */
async function buildRunContext(linearClient, teamKey, issues) {
  const states = await linearClient.workflowStates(teamKey);
  const stateId = (name) => {
    const s = states.find((st) => st.name === name);
    if (!s) throw new Error(`workflow state not found: ${name} (has the workspace been provisioned? see tools/dispatcher/scripts/provision-linear-workspace.mjs)`);
    return s.id;
  };

  const worktreeManager = new WorktreeManager({
    repoRoot: REPO_ROOT,
    worktreeRoot: worktreeRoot(),
    statePath: worktreesStatePath(),
  });

  return {
    linearClient,
    stateIds: {
      blocked: stateId(RUN_STATE_NAMES.blocked),
      agentWorking: stateId(RUN_STATE_NAMES.agentWorking),
      needsHumanDecision: stateId(RUN_STATE_NAMES.needsHumanDecision),
      inReview: stateId(RUN_STATE_NAMES.inReview),
    },
    worktreeManager,
    // MOV-144: a config value above the single-flight resource policy is not
    // honored until a nonblocking supervisor exists.
    concurrencyLimit: Math.min(Number(process.env.MOVIECAL_CONCURRENCY || DEFAULT_CONCURRENCY), DEFAULT_CONCURRENCY),
    workerTimeoutMs: Number(process.env.MOVIECAL_WORKER_TIMEOUT_MS || DEFAULT_WORKER_TIMEOUT_MS),
    iosRunnerOnline: await checkIosRunnerOnline(),
    isIssueSatisfied: buildIsIssueSatisfied(issues),
    secretPresent: () => fs.existsSync(envLocalPath()),
    worktreeRoot: worktreeRoot(),
    envLocalSource: fs.existsSync(envLocalPath()) ? envLocalPath() : undefined,
    ghRepo: GITHUB_REPO,
    logRoot: logRoot(),
    spawnWorkerFn: spawnWorker,
    findPrForBranchFn: (branch, repo) => findPrForBranch(branch, repo, ghRunner),
    uncommittedChangesFn: (worktreePath) => worktreeManager.uncommittedChanges(worktreePath),
    applyStagedWorkflowEditFn: (worktreePath, authorizedPath) => applyStagedWorkflowEdit(worktreePath, authorizedPath),
    // MOV-143: the route + delegate gate, and the live re-read that makes a
    // mid-flight routing/delegation change a no-op instead of a lost race.
    dispatcherDelegate: resolveDispatcherDelegate(),
    refreshIssueFn: (issue) => linearClient.issueSnapshot(issue.id),
  };
}

/**
 * Sweep worktrees sitting in "review" against their real PR state, so a
 * merged PR gets marked "merged" (dispatcher gc cleans it up) and a
 * closed-without-merging PR gets marked "abandoned" (7-day retention path),
 * with nobody having to notice and clean up by hand. Runs every poll cycle,
 * independent of whether there are new Ready-for-Agent issues.
 */
function reconcileWorktrees() {
  const worktreeManager = new WorktreeManager({
    repoRoot: REPO_ROOT,
    worktreeRoot: worktreeRoot(),
    statePath: worktreesStatePath(),
  });
  for (const c of worktreeManager.reconcileStartup()) {
    console.log(`${c.id}: startup recovery marked ${c.from} worktree ${c.to} — ${c.reason}`);
  }
  const changes = reconcileReviewWorktrees(worktreeManager, {
    ghRepo: GITHUB_REPO,
    checkPrStateFn: (prNumber, repo) => checkPrState(prNumber, repo, ghRunner),
    observePrFn: (prNumber, repo) => checkPrObservation(prNumber, repo, ghRunner),
  });
  for (const c of changes) {
    console.log(`${c.id}: PR #${c.prNumber} is ${c.to === "merged" ? "merged" : "closed"} — worktree marked "${c.to}"`);
  }
  return changes;
}

/** Report current CI decisions for review PRs; no worker or CI mutation occurs. */
async function reportReviewCi(linearClient, teamKey) {
  const reviewIssues = await linearClient.issuesInState({ teamKey, stateName: RUN_STATE_NAMES.inReview });
  const byIdentifier = new Map(reviewIssues.map((issue) => [issue.identifier, issue]));
  const manager = new WorktreeManager({ repoRoot: REPO_ROOT, worktreeRoot: worktreeRoot(), statePath: worktreesStatePath() });
  const results = [];
  for (const entry of Object.values(manager.loadState())) {
    if (entry.status !== "review" || !entry.prNumber) continue;
    const issue = byIdentifier.get(entry.id);
    if (!issue) continue;
    const observation = checkPrObservation(entry.prNumber, GITHUB_REPO, ghRunner);
    if (observation.observationError || !observation.headSha) continue;
    const events = (observation.checks?.checks || []).map((check) => ({ ...check, sha: check.sha || observation.headSha, conclusion: check.outcome }));
    const decision = decideCiOutcome({ prNumber: entry.prNumber, prUrl: entry.prUrl || null, headSha: observation.headSha, events });
    const existingBodies = linearClient.issueComments ? await linearClient.issueComments(issue.id) : [];
    results.push(await reportObservationToLinear({
      linearClient,
      issueId: issue.id,
      decision,
      observation: { requiredChecks: observation.checks.required.map((check) => check.name) },
      existingBodies,
    }));
  }
  return results;
}

/**
 * Automated backlog promoter (MOV-129): move issues in Backlog/Blocked that
 * meet the readiness contract into "Ready for Agent". Returns 0/1 for the
 * standalone `promote` command; `promotePass()` wraps it for the run loop.
 */
async function cmdPromoteOnce({ dryRun = false } = {}) {
  const built = buildLinearClient();
  if (!built) return 1;
  const { client: linearClient, teamKey } = built;

  const states = await linearClient.workflowStates(teamKey);
  const readyState = states.find((s) => s.name === RUN_STATE_NAMES.readyForAgent);
  if (!readyState) {
    console.error(`workflow state "${RUN_STATE_NAMES.readyForAgent}" not found (provision the workspace)`);
    return 1;
  }

  const issues = await linearClient.issuesForPromotion({ teamKey, stateNames: PROMOTABLE_STATES });
  const isBlockerSatisfied = buildIsIssueSatisfied(issues);
  const results = await promoteEligible(issues, {
    linearClient,
    readyForAgentStateId: readyState.id,
    isBlockerSatisfied,
    dryRun,
  });

  const promoted = results.filter((r) => r.promoted);
  for (const r of results) {
    if (r.promoted) console.log(`${r.issue}: ${dryRun ? "would promote" : "promoted"} — ${r.reason}`);
    else console.log(`${r.issue}: skip — ${r.reason}`);
  }
  console.log(
    dryRun
      ? `Dry run — ${promoted.length} issue(s) would be promoted, no Linear state changed.`
      : `Promoted ${promoted.length} issue(s) to "${RUN_STATE_NAMES.readyForAgent}".`,
  );
  return 0;
}

/** Run a promote pass inside the poll loop; never let it abort dispatch. */
async function promotePass() {
  try {
    await cmdPromoteOnce({ dryRun: false });
  } catch (err) {
    console.error("Promote pass failed (continuing to dispatch):", err.message);
  }
}

async function cmdRunOnce() {
  await promotePass();

  const built = buildLinearClient();
  if (!built) return 1;
  const { client: linearClient, teamKey } = built;
  reconcileWorktrees();
  try {
    await reportReviewCi(linearClient, teamKey);
  } catch (err) {
    console.error("CI observation reporting failed (continuing to dispatch):", err.message);
  }
  const issues = await linearClient.issuesInState({
    teamKey,
    stateName: RUN_STATE_NAMES.readyForAgent,
  });

  if (issues.length === 0) {
    console.log(`No issues in "${RUN_STATE_NAMES.readyForAgent}". Nothing to do.`);
    return 0;
  }

  const ctx = await buildRunContext(linearClient, teamKey, issues);
  const results = await runOnce(issues, ctx);
  for (const r of results) {
    console.log(`${r.issue}: ${r.outcome}${r.reason ? ` — ${r.reason}` : ""}${r.pr ? ` — ${r.pr}` : ""}`);
  }
  return 0;
}

async function cmdRun({ once, intervalMs }) {
  const lock = new DispatcherLock(dispatcherLockPath());
  try { lock.acquire(); } catch (err) { console.error(err.message); return 2; }
  process.once("exit", () => lock.release());
  if (once) { try { return await cmdRunOnce(); } finally { lock.release(); } }
  console.log(`Starting poll loop (interval: ${intervalMs}ms). Press Ctrl+C to stop.`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await cmdRunOnce();
    } catch (err) {
      console.error("Poll iteration failed:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
    case "shadow": {
      const prFlagIdx = rest.indexOf("--pr");
      const fixtureFlagIdx = rest.indexOf("--fixture");
      process.exitCode = cmdShadow({
        prNumber: prFlagIdx === -1 ? undefined : Number(rest[prFlagIdx + 1]),
        fixturePath: fixtureFlagIdx === -1 ? undefined : rest[fixtureFlagIdx + 1],
      });
      break;
    }
    case "promote": {
      const dryRun = rest.includes("--dry-run");
      process.exitCode = await cmdPromoteOnce({ dryRun });
      break;
    }
    case "run": {
      const once = rest.includes("--once");
      const intervalFlagIdx = rest.indexOf("--interval");
      const intervalMs = intervalFlagIdx !== -1 ? Number(rest[intervalFlagIdx + 1]) : DEFAULT_POLL_INTERVAL_MS;
      process.exitCode = await cmdRun({ once, intervalMs });
      break;
    }
    default:
      console.error("Usage: dispatcher <doctor|dry-run|shadow|gc|promote|run> [--pr <number>] [--fixture <path>] [--dry-run] [--once] [--interval <ms>]");
      process.exitCode = 1;
  }
}

main();
