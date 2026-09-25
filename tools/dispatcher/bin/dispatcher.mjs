#!/usr/bin/env node
// moviecal-dispatcher CLI.
//
// Usage:
//   dispatcher doctor              - read-only health check of every dependency
//   dispatcher dry-run             - fetch Ready-for-Agent issues and print the plan
//                                     without touching any worktree, branch, or Linear
//                                     state (safe to run with a live or missing key)
//   dispatcher agent-signal --fixture <path>
//                                  - replay a saved Linear Agent Session payload through
//                                     the normalization/trust/stop logic and print what it
//                                     would do. Read-only, and deliberately NOT a listener --
//                                     no port or secret is read here either way. The MOV-166
//                                     receiver lives on Vercel (src/app/api/agent-session/route.ts);
//                                     `dispatcher run` connects out to it (agent-stream-client.mjs)
//                                     but this command still runs fully offline, exercising the
//                                     identical normalization/trust/stop path with no network at all
//   dispatcher gc                  - prune merged/stale worktrees and old run logs
//   dispatcher promote [--dry-run] - move Backlog/Blocked issues that meet the
//                                     readiness contract into Ready for Agent
//                                     (MOV-129), assigning the configured
//                                     human owner first if one is missing
//                                     (MOV-359); the run loop does this each cycle
//   dispatcher priorities [--dry-run] [--once] - dependency-aware priority
//                                     propagation across incomplete issues
//   dispatcher audit-issues [--dry-run]
//                                  - comment on every open non-Triage issue that does
//                                     not satisfy the issue-completeness contract
//                                     (MOV-303/MOV-308); the run loop does this each
//                                     cycle. Comments are its only write — it never
//                                     changes a state, priority, label, project, or
//                                     milestone. `--dry-run` writes nothing at all
//   dispatcher repair --dry-run    - preview bounded repair admission without
//                                     reserving, spawning, rerunning, or writing
//   dispatcher master-ci --dry-run - preview post-merge master-CI incident
//                                     observation without writing the ledger,
//                                     Linear, GitHub, or a worktree
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
  usageLimitStatePath,
  repairLedgerStatePath,
  masterIncidentLedgerStatePath,
  prAutonomyLedgerStatePath,
  dispatcherLaunchHealthStatePath,
  priorityPropagationStatePath,
  issueSpecAuditStatePath,
  loadLinearConfig,
  loadLinearAppConfig,
  resolveLinearAuth,
  resolveDispatcherDelegate,
  agentSessionsEnabled,
  agentSessionSteeringEnabled,
  loadAgentSessionStreamConfig,
  agentSessionEnvPath,
  prAutonomyEnabled,
  resolvePrAutonomyMaxActions,
  masterCiObserverEnabled,
  resolveMasterVerificationWorkflows,
  resolveMasterIncidentRouteBudget,
  resolveMasterLineageMaxDistance,
  resolveMasterIncidentProject,
  resolveIssueSpecMode,
  resolveIssueSpecAuditIntervalMs,
  resolveDefaultOwnerEmail,
  checkSecretFileMode,
  DEFAULT_CONCURRENCY,
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
import { UsageLimitStore } from "../src/usage-limit.mjs";
import { runOnce } from "../src/run-loop.mjs";
import {
  buildRunContext,
  RUN_STATE_NAMES,
  GITHUB_REPO,
  IOS_RUNNER_NAME,
} from "../src/run-context.mjs";
import { buildIsIssueSatisfied } from "../src/dependency-gate.mjs";
import { promoteEligible, PROMOTABLE_STATES } from "../src/promoter.mjs";
import { createOwnerAssigner } from "../src/owner-assignment.mjs";
import { AUDITED_SPEC_STATE_TYPES, evaluateIssueSpec, formatIssueSpecMissing } from "../src/issue-spec.mjs";
import { auditIssueSpecs, IssueSpecAuditScheduleStore, isAuditDue } from "../src/issue-spec-audit.mjs";
import { propagatePriorities, TERMINAL_PRIORITY_STATE_TYPES } from "../src/priority-propagation.mjs";
import { reconcileParents } from "../src/parent-completion-guard.mjs";
import { defaultRunner as ghRunner } from "../src/pr-check.mjs";
import { checkPrState, checkPrObservation, isCheckPrObservation, reconcileReviewWorktrees } from "../src/pr-reconcile.mjs";
import { reconcileStartupRecoveries } from "../src/startup-recovery.mjs";
import { releaseIosWorkerLease } from "../src/ios-worker-lease.mjs";
import { decideCiOutcome, formatShadowReport, reportObservationToLinear } from "../src/ci-outcomes.mjs";
import { reportReviewCi as reportReviewCiPass } from "../src/review-ci-observer.mjs";
import { SignalLedger, StopController, handleAgentSignal } from "../src/agent-signals.mjs";
import { AgentStreamClient } from "../src/agent-stream-client.mjs";
import { previewRepairPass, runRepairPass } from "../src/repair-run.mjs";
import { RepairLedger } from "../src/repair-ledger.mjs";
import { PrAutonomyLedger, runPrAutonomyPass } from "../src/pr-autonomy.mjs";
import { MasterIncidentLedger } from "../src/master-incident-ledger.mjs";
import { runMasterCiPass, reconcileMasterIncidents, previewMasterCiPass } from "../src/master-ci-observer.mjs";
import {
  listMasterRuns,
  describeMasterRun,
  pullRequestsForCommit,
  masterCommitLineage,
  findMergedFixPullRequest,
  latestSuccessfulMasterRun,
} from "../src/master-ci-github.mjs";
import {
  checkGithubCliAuth,
  DispatcherLaunchHealthStore,
} from "../src/launch-health.mjs";

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

  // Agent Session enrichment layer (MOV-158). Informational, never a gate, and
  // deliberately does **not** probe the API: the only way to test entitlement
  // is `agentSessionCreateOnIssue`, which is a mutation, and `doctor` is
  // read-only. MOV-141 already recorded the live answer.
  checks.push({
    name: "Linear Agent Sessions",
    ok: true,
    detail: agentSessionsEnabled()
      ? "enabled (MOVIECAL_AGENT_SESSIONS) — activities are attempted once per attempt and fall back to app-actor comments if the app is not entitled"
      : "off (default) — lifecycle publishes as app-actor comments + state transitions, which is the complete surface; see docs/governance/mov-141-linear-capability-findings.md",
  });

  // Agent Session receiver stream (MOV-166). Also informational: no live
  // connection attempt here, `doctor` stays read-only. Only meaningful when
  // the layer above is enabled at all -- the stream is what carries events to
  // it, not a capability of its own.
  {
    const streamConfig = loadAgentSessionStreamConfig();
    const configured = AgentStreamClient.isConfigured(streamConfig);
    checks.push({
      name: "Agent Session receiver stream",
      ok: true,
      detail: !agentSessionsEnabled()
        ? "not started — Agent Sessions are off (MOVIECAL_AGENT_SESSIONS unset)"
        : configured
          ? `configured — outbound connection to ${streamConfig.streamUrl} on \`dispatcher run\``
          : `Agent Sessions are on but no stream is configured (set AGENT_SESSION_STREAM_URL/AGENT_SESSION_STREAM_CREDENTIAL in ${agentSessionEnvPath()}) — 30-second polling remains the complete recovery path`,
    });
  }

  // Live mid-run worker steering (MOV-214/215). A separate flag from the
  // receiver above: this one changes the worker invocation mode, so it is
  // never assumed on just because sessions are.
  checks.push({
    name: "Live worker prompt steering",
    ok: true,
    detail: agentSessionSteeringEnabled()
      ? "enabled (MOVIECAL_AGENT_SESSION_STEERING) — a trusted follow-up prompt is written to the running Claude worker's next turn; Codex attempts stay record-only"
      : "off (default) — a trusted follow-up prompt is recorded as a prompt-received lifecycle event, not delivered live",
  });

  // Issue-completeness contract (MOV-303/MOV-307). Informational: `report` is
  // the shipped default and is not a misconfiguration, so this never fails
  // the check — it exists so an operator can see which mode is live before
  // wondering why an incomplete issue did (or did not) promote.
  {
    const mode = resolveIssueSpecMode();
    const intervalHours = Math.round((resolveIssueSpecAuditIntervalMs() / (60 * 60 * 1000)) * 10) / 10;
    checks.push({
      name: "issue completeness contract",
      ok: true,
      detail:
        mode === "enforce"
          ? `enforce — an incomplete issue is neither promoted nor dispatched (fails preflight to Blocked), and every open non-Triage issue is audited automatically at most every ${intervalHours}h`
          : mode === "off"
            ? "off (MOVIECAL_ISSUE_SPEC_MODE=off) — neither the promoter/preflight gates nor the audit pass runs"
            : `report (default) — promotion and dispatch are unchanged; violations are logged and audited as issue comments at most every ${intervalHours}h. Switch to enforce once the backlog is backfilled`,
    });
  }

  // claude / codex on PATH
  for (const bin of ["claude", "codex"]) {
    const which = tryRun(() => execFileSync("which", [bin], { encoding: "utf8" }).trim());
    checks.push({ name: `${bin} on PATH`, ok: which.ok, detail: which.ok ? which.value : `not found (required for the ${bin} worker adapter)` });
  }

  // MOV-145: both adapters depend on the same inherited macOS Seatbelt
  // boundary. A missing/disabled sandbox is a hard health-check failure; the
  // dispatcher must not silently fall back to prompt-only permissions.
  const sandboxCheck = tryRun(() =>
    execFileSync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        '(version 1) (allow default) (deny process-exec (literal "/usr/bin/git"))',
        "/bin/sh",
        "-c",
        "/usr/bin/git --version >/dev/null 2>&1; test $? -ne 0",
      ],
      { encoding: "utf8" },
    ),
  );
  checks.push({
    name: "worker safety sandbox",
    ok: sandboxCheck.ok,
    detail: sandboxCheck.ok ? "macOS sandbox-exec enforced a child-process Git denial" : sandboxCheck.error,
  });

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

/** Read-only view of the launchd first-poll record, for an operator. */
function cmdHealth() {
  const health = new DispatcherLaunchHealthStore(dispatcherLaunchHealthStatePath()).status();
  console.log(JSON.stringify(health, null, 2));
  return ["healthy", "unknown"].includes(health.status) ? 0 : 1;
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
    issues = await built.client.issuesInState({ teamKey: built.teamKey, stateName: "Ready for Agent", includeSpecFields: true });
  }

  const manager = new WorktreeManager({
    repoRoot: REPO_ROOT,
    worktreeRoot: worktreeRoot(),
    statePath: worktreesStatePath(),
  });
  const activeWorktreeCount = tryRun(() => manager.activeCount());
  // MOV-205: read-only. A deferred or resume-pending issue looks like an
  // ordinary preflight collision from the plain path check below (this
  // command deliberately never reclaims), so print the durable record's own
  // view alongside it rather than leaving the operator to guess.
  const usageLimits = new UsageLimitStore(usageLimitStatePath());

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
      // dry-run: deliberately plain isPathFree, not isPathFreeForIssue
      // (MOV-181) -- the latter performs a real `git worktree remove` when
      // it reclaims, which would violate this command's "no worktree,
      // branch, or Linear state was changed" guarantee.
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
    const usage = tryRun(() => ({
      deferral: usageLimits.deferral(issue.identifier),
      resumption: usageLimits.resumption(issue.identifier),
      record: usageLimits.get(issue.identifier),
    }));
    if (usage.ok && usage.value.record) {
      const { deferral, resumption, record } = usage.value;
      const status = deferral.deferred
        ? `DEFERRED until ${deferral.until}${record.resume ? " (will resume the retained worktree in place)" : ""}`
        : resumption
          ? `RESUME DUE — the retained worktree at ${resumption.worktreePath} will be resumed in place, re-admission permitting`
          : `no active deferral (${record.consecutive} consecutive provider limit(s) recorded)`;
      console.log(`  usage limit: ${status}`);
    }
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
    if (!isCheckPrObservation(observation)) {
      console.error("shadow fixture must match the checkPrObservation shape");
      return 1;
    }
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

/**
 * Replay one Agent Session webhook payload from a file, with no listener and
 * no network (MOV-158).
 *
 * This is how the inbound half is exercised by hand: MOV-141 found Agent
 * Sessions disabled for this app, and enabling them would need a reachable
 * HTTPS receiver the local Mac must not expose (MOV-159 is that decision
 * gate). The normalization, trust, and stop-control logic is real and shared
 * with the polling path; only the transport is absent. This command reports
 * what *would* happen and changes nothing — no Linear write, no worktree, no
 * worker.
 */
function cmdAgentSignal({ fixturePath } = {}) {
  if (!fixturePath) {
    console.error("agent-signal requires --fixture <path to a saved Agent Session payload>");
    return 1;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  } catch (err) {
    console.error(`could not read the agent-signal fixture: ${err.message}`);
    return 1;
  }
  const controller = new StopController();
  const ledger = new SignalLedger();
  const first = handleAgentSignal(payload, { controller, ledger });
  // Replayed immediately against the same ledger, because "a retried delivery
  // must be a no-op" is the property worth showing, not an implementation
  // detail.
  const replay = handleAgentSignal(payload, { controller, ledger });
  console.log(
    JSON.stringify(
      {
        mode: "agent-signal",
        readOnly: true,
        listener: false,
        first,
        replay,
        stopRequest: controller.stopRequest,
        wouldMutateLinear: false,
      },
      null,
      2,
    ),
  );
  return 0;
}

/**
 * Sweep worktrees sitting in "review" against their real PR state, so a
 * merged PR gets marked "merged" (dispatcher gc cleans it up) and a
 * closed-without-merging PR gets marked "abandoned" (7-day retention path),
 * with nobody having to notice and clean up by hand. Runs every poll cycle,
 * independent of whether there are new Ready-for-Agent issues.
 *
 * MOV-152: when a `linearClient` is available, this also backstops Linear's
 * own GitHub magic-word sync — idempotently moving a merged PR's issue to
 * Done if that sync hasn't happened yet, and escalating a closed-unmerged
 * PR's issue to Needs Human Decision (unless it's already terminal). Without
 * a live Linear credential, only the worktree bookkeeping half runs; the
 * backstop simply retries on the next poll cycle that has one.
 */
async function reconcileWorktrees(linearClient, teamKey) {
  const worktreeManager = new WorktreeManager({
    repoRoot: REPO_ROOT,
    worktreeRoot: worktreeRoot(),
    statePath: worktreesStatePath(),
  });
  const startupChanges = worktreeManager.reconcileStartup();
  for (const c of startupChanges) {
    // Two change shapes share this array: a state-entry recovery ({id, from,
    // to, reason}) and an orphan-sweep outcome ({path, branch, from, to,
    // reason}, MOV-199) -- neither has the other's identifying field, so
    // `c.id` alone silently printed "undefined" for every orphan-sweep
    // event, forever. Fall back to the path (plus branch, when known) so the
    // log always names what was actually acted on.
    const label = c.id ?? `${c.path}${c.branch ? ` (${c.branch})` : ""}`;
    console.log(`${label}: startup recovery marked ${c.from} worktree ${c.to} — ${c.reason}`);
  }

  let doneStateId;
  let needsHumanDecisionStateId;
  let readyForAgentStateId;
  let inReviewStateId;
  if (linearClient && teamKey) {
    try {
      const states = await linearClient.workflowStates(teamKey);
      doneStateId = states.find((s) => s.name === RUN_STATE_NAMES.done)?.id;
      needsHumanDecisionStateId = states.find((s) => s.name === RUN_STATE_NAMES.needsHumanDecision)?.id;
      readyForAgentStateId = states.find((s) => s.name === RUN_STATE_NAMES.readyForAgent)?.id;
      inReviewStateId = states.find((s) => s.name === RUN_STATE_NAMES.inReview)?.id;
    } catch (err) {
      console.error("Could not resolve Linear workflow states for PR-outcome reconciliation (continuing worktree-only):", err.message);
    }
  }

  await reconcileStartupRecoveries(startupChanges, {
    worktreeManager,
    linearClient,
    readyForAgentStateId,
    needsHumanDecisionStateId,
    releaseIosSimLeaseFn: releaseIosWorkerLease,
  });

  const changes = await reconcileReviewWorktrees(worktreeManager, {
    ghRepo: GITHUB_REPO,
    checkPrStateFn: (prNumber, repo) => checkPrState(prNumber, repo, ghRunner),
    observePrFn: (prNumber, repo) => checkPrObservation(prNumber, repo, ghRunner),
    linearClient,
    doneStateId,
    needsHumanDecisionStateId,
    inReviewStateId,
  });
  for (const c of changes) {
    console.log(`${c.id}: PR #${c.prNumber} is ${c.to === "merged" ? "merged" : "closed"} — worktree marked "${c.to}"`);
  }
  return changes;
}

/** Report current CI decisions for review PRs; no worker or CI mutation occurs. */
async function reportReviewCi(linearClient, teamKey) {
  return reportReviewCiPass({
    linearClient,
    teamKey,
    inReviewStateName: RUN_STATE_NAMES.inReview,
    WorktreeManager,
    worktreeManagerOptions: { repoRoot: REPO_ROOT, worktreeRoot: worktreeRoot(), statePath: worktreesStatePath() },
    observePrFn: (prNumber, repo) => checkPrObservation(prNumber, repo, ghRunner),
    githubRepo: GITHUB_REPO,
    decideCiOutcome,
    reportObservationToLinear,
  });
}

/**
 * MOV-162's only mutating path. It runs under the dispatcher's existing
 * process lock and delegates every allow/deny decision to the pure policy.
 */
async function runPrAutonomy(linearClient, teamKey) {
  if (!prAutonomyEnabled()) return [];
  const issues = await linearClient.issuesInState({ teamKey, stateName: RUN_STATE_NAMES.inReview });
  const worktreeManager = new WorktreeManager({ repoRoot: REPO_ROOT, worktreeRoot: worktreeRoot(), statePath: worktreesStatePath() });
  return runPrAutonomyPass({
    issues,
    worktreeManager,
    observePrFn: (prNumber, repo) => checkPrObservation(prNumber, repo, ghRunner),
    repo: GITHUB_REPO,
    ledger: new PrAutonomyLedger(prAutonomyLedgerStatePath()),
    repairLedger: new RepairLedger(repairLedgerStatePath()),
    enabled: true,
    maxActions: resolvePrAutonomyMaxActions(),
    runner: ghRunner,
    linearClient,
  });
}

/**
 * Automated backlog promoter (MOV-129): move issues in Backlog/Blocked that
 * meet the readiness contract into "Ready for Agent". Returns 0/1 for the
 * standalone `promote` command; `promotePass()` wraps it for the run loop.
 *
 * MOV-359: also fills a missing assignee with the configured human owner
 * immediately before that transition, so the handoff Loop can delegate the
 * issue afterward. A fresh `ownerAssignment` orchestrator is built every
 * call, so a transient lookup/assignment failure is retried from scratch on
 * the very next pass rather than latched.
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

  const issueSpecMode = resolveIssueSpecMode();
  const ownerAssignment = createOwnerAssigner({ linearClient, teamKey, ownerEmail: resolveDefaultOwnerEmail() });
  const issues = await linearClient.issuesForPromotion({ teamKey, stateNames: PROMOTABLE_STATES });
  const isBlockerSatisfied = buildIsIssueSatisfied(issues);
  const results = await promoteEligible(issues, {
    linearClient,
    readyForAgentStateId: readyState.id,
    isBlockerSatisfied,
    dryRun,
    issueSpecMode,
    ownerAssignment,
  });

  const promoted = results.filter((r) => r.promoted);
  for (const r of results) {
    if (r.promoted) {
      const ownerNote = r.ownerAssigned
        ? `; assigned ${r.ownerName || "configured owner"}`
        : r.ownerPlanned
          ? `; would assign ${r.ownerName || "configured owner"}`
          : "";
      console.log(`${r.issue}: ${dryRun ? "would promote" : "promoted"}${ownerNote} — ${r.reason}`);
    } else {
      console.log(`${r.issue}: skip — ${r.reason}`);
    }
    // MOV-303/MOV-307: in `report` mode (the default) an incomplete issue
    // still promotes, so its violations would otherwise be invisible here.
    // Log them on every non-enforcing pass — in `enforce` mode they are
    // already the skip reason above, and repeating them would just double
    // the output.
    if (issueSpecMode !== "enforce" && r.specViolations.length > 0) {
      console.log(`${r.issue}: issue-spec violations (${issueSpecMode} mode, not enforced) — ${r.specViolations.join("; ")}`);
    }
  }
  console.log(
    dryRun
      ? `Dry run — ${promoted.length} issue(s) would be promoted, no Linear state changed.`
      : `Promoted ${promoted.length} issue(s) to "${RUN_STATE_NAMES.readyForAgent}".`,
  );
  return 0;
}

/**
 * Issue-completeness audit pass (MOV-308): comment on every open non-`Triage`
 * issue that does not satisfy the contract — including the `human-only`,
 * coordination, `Spec Ready`, `Icebox`, and started issues the promoter never
 * looks at.
 *
 * `off` returns before a Linear client is even built, so the read-only
 * guarantee for that mode is structural rather than a promise made by the
 * pass's own logic. `report` and `enforce` behave identically here: the audit
 * only ever reports, whatever the mode — the promoter is the pass that can
 * actually withhold dispatch, and duplicating enforcement in a comment-only
 * pass would mean nothing.
 */
async function cmdAuditIssuesOnce({ dryRun = false } = {}) {
  const issueSpecMode = resolveIssueSpecMode();
  if (issueSpecMode === "off") {
    console.log("Issue-completeness audit skipped (MOVIECAL_ISSUE_SPEC_MODE=off) — nothing read, nothing written.");
    return 0;
  }

  const built = buildLinearClient();
  if (!built) return 1;
  const { client: linearClient, teamKey } = built;

  // Selected by workflow-state *type*, never by a hardcoded name list: a state
  // added to this workspace later is audited automatically, while `triage`,
  // `completed`, and `canceled` stay out by construction.
  const states = await linearClient.workflowStates(teamKey);
  const stateNames = states
    .filter((state) => AUDITED_SPEC_STATE_TYPES.has(String(state.type || "").toLowerCase()))
    .map((state) => state.name);
  if (stateNames.length === 0) {
    console.error("no auditable workflow states found (provision the workspace)");
    return 1;
  }

  const issues = await linearClient.issuesForSpecAudit({ teamKey, stateNames });
  const results = await auditIssueSpecs(issues, { linearClient, dryRun });

  let wrote = 0;
  for (const result of results) {
    if (result.action === "commented" || result.action === "updated") {
      wrote++;
      const verb = dryRun ? `would ${result.action === "updated" ? "update" : "comment"}` : result.action;
      console.log(`${result.issue}: issue-spec audit ${verb} — ${result.missing.join("; ")}`);
    } else if (result.action === "unchanged") {
      console.log(`${result.issue}: issue-spec audit unchanged (already commented) — ${result.missing.join("; ")}`);
    }
  }
  console.log(
    dryRun
      ? `Dry run — ${wrote} issue-completeness comment(s) would be posted across ${results.length} issue(s), nothing written.`
      : `Issue-completeness audit posted ${wrote} comment(s) across ${results.length} issue(s).`,
  );
  return 0;
}

async function cmdAuditIssues({ dryRun = false } = {}) {
  // A dry run is read-only, so it must never contend for the singleton lock —
  // previewing the audit while the daemon is running is a normal thing to do.
  if (dryRun) return cmdAuditIssuesOnce({ dryRun: true });
  const lock = new DispatcherLock(dispatcherLockPath());
  try { lock.acquire(); } catch (err) { console.error(err.message); return 2; }
  process.once("exit", () => lock.release());
  try {
    const exitCode = await cmdAuditIssuesOnce({ dryRun: false });
    if (exitCode === 0) recordIssueSpecAuditCompleted();
    return exitCode;
  } finally {
    lock.release();
  }
}

async function cmdPrioritiesOnce({ dryRun = false } = {}) {
  const built = buildLinearClient();
  if (!built) return 1;
  const { client: linearClient, teamKey } = built;
  const states = await linearClient.workflowStates(teamKey);
  const nonTerminalStateNames = states
    .filter((state) => !TERMINAL_PRIORITY_STATE_TYPES.has((state.type || "").toLowerCase()))
    .map((state) => state.name);

  const issues = await linearClient.issuesForPriorityPropagation({ teamKey, stateNames: nonTerminalStateNames });
  const result = await propagatePriorities(issues, {
    linearClient,
    stateFilePath: priorityPropagationStatePath(),
    dryRun,
    logger: console,
  });

  for (const update of result.updates) {
    if (update.action === "raised") {
      console.log(`${update.identifier}: ${update.from} -> ${update.to} (raised by ${update.driverIdentifier})`);
    } else {
      console.log(`${update.identifier}: ${update.from} -> ${update.to} (relaxed)`);
    }
  }
  for (const skip of result.skipped) {
    console.log(
      `${skip.identifier} (${skip.stateName}): skipped (would raise to ${skip.to}, blocks ${skip.driverIdentifier})`,
    );
  }

  if (dryRun) {
    console.log("Dry run — no Linear priority updates or propagation state-file writes.");
  } else {
    console.log(`Applied ${result.wrote} propagated priority update(s).`);
  }
  return 0;
}

async function cmdPriorities({ dryRun = false } = {}) {
  if (dryRun) return cmdPrioritiesOnce({ dryRun: true });
  const lock = new DispatcherLock(dispatcherLockPath());
  try { lock.acquire(); } catch (err) { console.error(err.message); return 2; }
  process.once("exit", () => lock.release());
  try {
    return await cmdPrioritiesOnce({ dryRun: false });
  } finally {
    lock.release();
  }
}

/** Run a promote pass inside the poll loop; never let it abort dispatch. */
async function promotePass() {
  try {
    await cmdPromoteOnce({ dryRun: false });
  } catch (err) {
    console.error("Promote pass failed (continuing to dispatch):", err.message);
  }
}

/** Persist a successful audit so restarts respect the configured cadence. */
function recordIssueSpecAuditCompleted() {
  new IssueSpecAuditScheduleStore(issueSpecAuditStatePath()).save({ lastRunAt: Date.now() });
}

/** Run the issue-completeness audit inside the poll loop; never abort dispatch. */
async function auditIssuesPass() {
  if (resolveIssueSpecMode() === "off") return;
  const scheduleStore = new IssueSpecAuditScheduleStore(issueSpecAuditStatePath());
  if (!isAuditDue(scheduleStore.loadOrReset().lastRunAt, Date.now(), resolveIssueSpecAuditIntervalMs())) return;
  try {
    await cmdAuditIssuesOnce({ dryRun: false });
    recordIssueSpecAuditCompleted();
  } catch (err) {
    console.error("Issue-completeness audit pass failed (continuing to dispatch):", err.message);
  }
}

/** Run a priority propagation pass inside the poll loop; never abort dispatch. */
async function propagatePass() {
  try {
    await cmdPrioritiesOnce({ dryRun: false });
  } catch (err) {
    console.error("Priority propagation pass failed (continuing to dispatch):", err.message);
  }
}

async function cmdReconcileParentsOnce({ dryRun = false } = {}) {
  const built = buildLinearClient();
  if (!built) return 1;
  const { client: linearClient, teamKey } = built;
  const states = await linearClient.workflowStates(teamKey);
  const doneState = states.find((state) => state.name === RUN_STATE_NAMES.done);
  const needsHumanDecisionState = states.find((state) => state.name === RUN_STATE_NAMES.needsHumanDecision);
  if (!doneState || !needsHumanDecisionState) {
    console.error(`workflow state not found (need "${RUN_STATE_NAMES.done}" and "${RUN_STATE_NAMES.needsHumanDecision}")`);
    return 1;
  }
  const results = await reconcileParents(await linearClient.issuesForParentReconciliation({ teamKey }), {
    linearClient,
    doneStateId: doneState.id,
    needsHumanDecisionStateId: needsHumanDecisionState.id,
    dryRun,
  });
  for (const result of results) {
    if (result.action !== "none") console.log(`${result.issue}: ${dryRun ? "would " : ""}${result.action} — ${result.reason}`);
  }
  return 0;
}

async function cmdReconcileParents({ dryRun = false } = {}) {
  if (dryRun) return cmdReconcileParentsOnce({ dryRun: true });
  const lock = new DispatcherLock(dispatcherLockPath());
  try { lock.acquire(); } catch (err) { console.error(err.message); return 2; }
  process.once("exit", () => lock.release());
  try {
    return await cmdReconcileParentsOnce({ dryRun: false });
  } finally {
    lock.release();
  }
}

async function reconcileParentsPass() {
  try {
    await cmdReconcileParentsOnce({ dryRun: false });
  } catch (err) {
    console.error("Parent-completion reconciliation pass failed (continuing to dispatch):", err.message);
  }
}

/**
 * Build the one master-CI observer context shared by the live in-loop pass
 * and its read-only preview. Keeping the GitHub adapters here makes the
 * observer module independently testable with fixtures while this CLI owns
 * the only production wiring.
 */
async function buildMasterCiContext(linearClient, teamKey, { enabled } = {}) {
  const states = await linearClient.workflowStates(teamKey);
  const stateId = (name) => states.find((state) => state.name === name)?.id || null;
  const { projectName, milestoneName } = resolveMasterIncidentProject();
  return {
    enabled,
    githubRepo: GITHUB_REPO,
    linearClient,
    teamKey,
    ledger: new MasterIncidentLedger(masterIncidentLedgerStatePath()),
    stateIds: {
      backlog: stateId("Backlog"),
      needsHumanDecision: stateId(RUN_STATE_NAMES.needsHumanDecision),
      done: stateId(RUN_STATE_NAMES.done),
    },
    workflows: resolveMasterVerificationWorkflows(),
    routeBudget: resolveMasterIncidentRouteBudget(),
    maxLineageDistance: resolveMasterLineageMaxDistance(),
    projectName,
    milestoneName,
    listMasterRunsFn: listMasterRuns,
    describeMasterRunFn: describeMasterRun,
    pullRequestsForCommitFn: pullRequestsForCommit,
    masterCommitLineageFn: masterCommitLineage,
    findMergedFixPullRequestFn: findMergedFixPullRequest,
    latestSuccessfulMasterRunFn: latestSuccessfulMasterRun,
  };
}

/**
 * Post-merge master observation belongs to the normal lifecycle, but must
 * never make a healthy implementation queue unavailable. It is opt-in: an
 * unset switch does not even construct the context or read the ledger.
 */
async function masterCiPass(linearClient, teamKey) {
  if (!masterCiObserverEnabled()) return [];
  try {
    const ctx = await buildMasterCiContext(linearClient, teamKey, { enabled: true });
    const reconciled = await reconcileMasterIncidents(ctx);
    const observed = await runMasterCiPass(ctx);
    for (const result of [...reconciled, ...observed]) {
      console.log(`master-ci: ${result.issue || result.runId || result.key || "pass"}: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`);
    }
    return { reconciled, observed };
  } catch (err) {
    console.error("Master CI observation pass failed (continuing to dispatch):", err.message);
    return [];
  }
}

async function cmdRunOnce({ repairLockHeld = false } = {}) {
  // buildLinearClient() must run first: reconcileWorktrees() below takes its
  // result (a possibly-undefined client/teamKey) as arguments, and degrades
  // to worktree-only bookkeeping when there's no live Linear credential --
  // see reconcileWorktrees() for that fallback. The rest of this function
  // reuses the same linearClient/teamKey rather than re-deriving them.
  const built = buildLinearClient();
  const linearClient = built?.client;
  const teamKey = built?.teamKey;

  // This is intentionally before reconciliation: that path can observe PRs
  // and may publish lifecycle changes. A broken launchd `gh` credential must
  // never reach either observation or mutation, even when Linear works.
  const githubAuth = checkGithubCliAuth();
  if (!githubAuth.ok) {
    console.error(`Dispatcher startup blocked (${githubAuth.kind}): ${githubAuth.diagnostic}`);
    return { exitCode: 3, startupFailure: githubAuth };
  }

  // reconcileWorktrees() is async: this await must fully complete before
  // promotePass() and reportReviewCi() run below, so reconciliation never
  // races the promote/dispatch pass. It is the only call to that function.
  await reconcileWorktrees(linearClient, teamKey);
  await reconcileParentsPass();
  // Reconcile completed master remediations before observing fresh failures:
  // a verified closure releases its bounded route capacity in this same poll.
  // The pass owns its own error boundary so an unavailable GitHub/Linear
  // observation can never prevent regular issue dispatch.
  if (built) await masterCiPass(linearClient, teamKey);
  await propagatePass();
  await promotePass();
  // MOV-308: after the promoter (so an issue promoted this cycle is audited in
  // the state it landed in) and before the dispatch read below. It is
  // comment-only and independently guarded, so it can never keep dispatch from
  // progressing.
  await auditIssuesPass();

  if (!built) return { exitCode: 1, startupFailure: { kind: "linear-auth-unavailable", diagnostic: "Linear authentication is unavailable; run dispatcher doctor and repair the configured credential." } };

  try {
    await reportReviewCi(linearClient, teamKey);
  } catch (err) {
    console.error("CI observation reporting failed (continuing to dispatch):", err.message);
  }

  const issues = await linearClient.issuesInState({
    teamKey,
    stateName: RUN_STATE_NAMES.readyForAgent,
    includeSpecFields: true,
  });
  if (resolveIssueSpecMode() === "report") {
    for (const issue of issues) {
      const missing = formatIssueSpecMissing(evaluateIssueSpec(issue));
      if (missing.length > 0) console.log(`${issue.identifier}: issue-spec violations (report mode, not enforced) — ${missing.join("; ")}`);
    }
  }

  const ctx = await buildRunContext(linearClient, teamKey, issues, { repairLockHeld });
  // MOV-190: repair targets are retained review worktrees, not new Ready for
  // Agent issues. Run their bounded pass every poll cycle, including when the
  // dispatch queue is empty. It is independently guarded and must never keep
  // ordinary issue dispatch from progressing.
  try {
    const repairs = await runRepairPass(ctx);
    for (const repair of repairs) {
      console.log(`${repair.issue}: ${repair.outcome}${repair.reason ? ` — ${repair.reason}` : ""}${repair.pr ? ` — ${repair.pr}` : ""}`);
    }
  } catch (err) {
    console.error("Automatic repair pass failed (continuing to dispatch):", err.message);
  }

  try {
    const actions = await runPrAutonomy(linearClient, teamKey);
    for (const action of actions) {
      if (action.action !== "none") console.log(`${action.issue}: PR autonomy ${action.action} — ${action.reason}`);
    }
  } catch (err) {
    console.error("PR autonomy pass failed (continuing with manual review):", err.message);
  }

  if (issues.length === 0) {
    console.log(`No issues in "${RUN_STATE_NAMES.readyForAgent}". Nothing to do.`);
    return { exitCode: 0 };
  }

  const results = await runOnce(issues, ctx);
  for (const r of results) {
    console.log(`${r.issue}: ${r.outcome}${r.reason ? ` — ${r.reason}` : ""}${r.pr ? ` — ${r.pr}` : ""}`);
  }
  return { exitCode: 0 };
}

/**
 * MOV-166: the Mac's outbound half of the Agent Session receiver, built only
 * when both the capability flag and stream config are present. Absent
 * either, this returns null and the dispatcher behaves exactly as it does
 * today -- 30-second polling, the complete recovery path either way.
 */
function buildAgentStreamClient() {
  if (!agentSessionsEnabled()) return null;
  const streamConfig = loadAgentSessionStreamConfig();
  if (!AgentStreamClient.isConfigured(streamConfig)) return null;
  return new AgentStreamClient(streamConfig);
}

async function cmdRun({ once, intervalMs }) {
  const lock = new DispatcherLock(dispatcherLockPath());
  try { lock.acquire(); } catch (err) { console.error(err.message); return 2; }
  process.once("exit", () => lock.release());
  const launchHealth = new DispatcherLaunchHealthStore(dispatcherLaunchHealthStatePath());
  launchHealth.beginFirstPoll();
  if (once) {
    try {
      const result = await cmdRunOnce({ repairLockHeld: lock.owned });
      if (result.exitCode === 0) launchHealth.completeFirstPoll();
      else launchHealth.failFirstPoll(result.startupFailure || { kind: "first-poll-failed", diagnostic: "Dispatcher first poll did not complete successfully; inspect dispatcher.stderr.log." });
      return result.exitCode;
    } finally { lock.release(); }
  }

  // Only for the persistent poll loop -- a single `--once` pass has nothing
  // for a live stream to usefully feed. Fire-and-forget: it manages its own
  // reconnect loop and never blocks a poll iteration.
  const streamClient = buildAgentStreamClient();
  if (streamClient) streamClient.start();

  // A dispatch worker may run longer than the CI jobs on review PRs. Keep the
  // read-only observer alive independently so a pending snapshot cannot hide
  // a later terminal failure until that unrelated worker returns. This is
  // intentionally observation-only: repair still runs through cmdRunOnce's
  // single-flight, lock-held path and therefore cannot mutate a PR while the
  // implementation worker owns the only dispatch slot.
  let observingReviewCi = false;
  const reviewCiMonitor = setInterval(async () => {
    if (observingReviewCi) return;
    observingReviewCi = true;
    try {
      const built = buildLinearClient();
      if (built) await reportReviewCi(built.client, built.teamKey);
    } catch (err) {
      console.error("Background CI observation failed (continuing to dispatch):", err.message);
    } finally {
      observingReviewCi = false;
    }
  }, intervalMs);
  process.once("exit", () => clearInterval(reviewCiMonitor));

  console.log(`Starting poll loop (interval: ${intervalMs}ms). Press Ctrl+C to stop.`);
  // eslint-disable-next-line no-constant-condition
  let firstPoll = true;
  while (true) {
    try {
      const result = await cmdRunOnce({ repairLockHeld: lock.owned });
      if (firstPoll) {
        if (result.exitCode === 0) launchHealth.completeFirstPoll();
        else {
          launchHealth.failFirstPoll(result.startupFailure || { kind: "first-poll-failed", diagnostic: "Dispatcher first poll did not complete successfully; inspect dispatcher.stderr.log." });
          return result.exitCode;
        }
        firstPoll = false;
      }
    } catch (err) {
      console.error("Poll iteration failed:", err.message);
      if (firstPoll) {
        launchHealth.failFirstPoll({ kind: "first-poll-threw", diagnostic: "Dispatcher first poll threw before completion; inspect dispatcher.stderr.log." });
        return 1;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Read-only repair preview. A real repair can only start through `run`. */
async function cmdRepair({ dryRun = false } = {}) {
  if (!dryRun) {
    console.error("repair requires --dry-run; live repair runs only inside `dispatcher run`");
    return 1;
  }
  const built = buildLinearClient();
  if (!built) return 1;
  const ctx = await buildRunContext(built.client, built.teamKey, []);
  const results = await previewRepairPass(ctx);
  console.log(JSON.stringify({ mode: "repair-preview", readOnly: true, results }, null, 2));
  return 0;
}

/**
 * Read-only master-CI observer preview. A real observation is intentionally
 * available only inside `dispatcher run`, behind the explicit environment
 * switch and the dispatcher's singleton lifecycle lock.
 */
async function cmdMasterCi({ dryRun = false } = {}) {
  if (!dryRun) {
    console.error("master-ci requires --dry-run; live observation runs only inside `dispatcher run` when MOVIECAL_MASTER_CI_OBSERVER is enabled");
    return 1;
  }
  const built = buildLinearClient();
  if (!built) return 1;
  const ctx = await buildMasterCiContext(built.client, built.teamKey, { enabled: true });
  const results = await previewMasterCiPass(ctx);
  console.log(JSON.stringify({
    mode: "master-ci-preview",
    readOnly: true,
    liveObservationEnabled: masterCiObserverEnabled(),
    results,
  }, null, 2));
  return 0;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "doctor":
      process.exitCode = await cmdDoctor();
      break;
    case "health":
      process.exitCode = cmdHealth();
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
    case "agent-signal": {
      const fixtureFlagIdx = rest.indexOf("--fixture");
      process.exitCode = cmdAgentSignal({
        fixturePath: fixtureFlagIdx === -1 ? undefined : rest[fixtureFlagIdx + 1],
      });
      break;
    }
    case "priorities": {
      const dryRun = rest.includes("--dry-run");
      process.exitCode = await cmdPriorities({ dryRun });
      break;
    }
    case "audit-issues": {
      process.exitCode = await cmdAuditIssues({ dryRun: rest.includes("--dry-run") });
      break;
    }
    case "reconcile-parents": {
      process.exitCode = await cmdReconcileParents({ dryRun: rest.includes("--dry-run") });
      break;
    }
    case "repair": {
      process.exitCode = await cmdRepair({ dryRun: rest.includes("--dry-run") });
      break;
    }
    case "master-ci": {
      process.exitCode = await cmdMasterCi({ dryRun: rest.includes("--dry-run") });
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
      console.error(
        "Usage: dispatcher <doctor|health|dry-run|shadow|agent-signal|gc|promote|priorities|audit-issues|reconcile-parents|repair|master-ci|run> [--pr <number>] [--fixture <path>] [--dry-run] [--once] [--interval <ms>]",
      );
      process.exitCode = 1;
  }
}

main();
