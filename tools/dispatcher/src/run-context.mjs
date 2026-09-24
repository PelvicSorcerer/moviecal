// The real (non-fake) run context the live poll loop wires up for
// run-loop.mjs's runOnce(), plus the small set of identifiers its CLI callers
// share (the GitHub repo, the iOS runner name, the run-state name map, and
// the process-wide Agent Session entitlement latch).
//
// Split out of bin/dispatcher.mjs (MOV-197): that file calls main() at
// module load, so it can never be imported for testing, which is exactly how
// two real wiring gaps (MOV-128's isIssueSatisfied, MOV-192's usageLimitStore)
// shipped past every existing unit test -- each dependency was itself well
// tested, but nothing dynamically exercised buildRunContext() actually
// wiring them together. This module is that function, made importable, with
// its behavior otherwise unchanged. See tools/dispatcher/test/run-loop-e2e.test.mjs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  worktreeRoot,
  worktreesStatePath,
  circuitBreakerStatePath,
  usageLimitStatePath,
  repairLedgerStatePath,
  envLocalPath,
  logRoot,
  resolveDispatcherDelegate,
  agentSessionsEnabled,
  agentSessionSteeringEnabled,
  autoRepairEnabled,
  resolveTrustedReviewers,
  resolveRepairBudgets,
  resolveIssueSpecMode,
  DEFAULT_CONCURRENCY,
  DEFAULT_WORKER_TIMEOUT_MS,
  DEFAULT_STOP_POLL_INTERVAL_MS,
  REPO_ROOT,
} from "./config.mjs";
import { WorktreeManager } from "./worktree-manager.mjs";
import { CircuitBreakerStore } from "./circuit-breaker.mjs";
import { UsageLimitStore } from "./usage-limit.mjs";
import { RepairLedger } from "./repair-ledger.mjs";
import { buildIsIssueSatisfied } from "./dependency-gate.mjs";
import { spawnWorker } from "./worker-spawn.mjs";
import { auditWorkerResult, writeWorkerAudit } from "./worker-guard.mjs";
import { publishWorkerResult } from "./worker-publish.mjs";
import { publishRepairResult } from "./worker-publish.mjs";
import { defaultRunner as ghRunner } from "./pr-check.mjs";
import { checkPrObservation } from "./pr-reconcile.mjs";
import { rerunFailedJobs, collectRepairEvidence, commentOnPullRequest } from "./repair-github.mjs";
import { collectRepositoryContext } from "./repository-context.mjs";
import { applyStagedWorkflowEdit } from "./workflow-edit-apply.mjs";
import { AgentSessionBridge, createAgentSessionCapability } from "./agent-session.mjs";
import { diagnoseUnrecognizedFailure } from "./worker-diagnosis.mjs";
import { captureVerificationEvidence } from "./readiness-evidence.mjs";
import { acquireIosWorkerLease, releaseIosWorkerLease } from "./ios-worker-lease.mjs";

export const IOS_RUNNER_NAME = "moviecal-ios-runner";
export const GITHUB_REPO = "PelvicSorcerer/moviecal";

export const RUN_STATE_NAMES = {
  readyForAgent: "Ready for Agent",
  blocked: "Blocked",
  agentWorking: "Agent Working",
  needsHumanDecision: "Needs Human Decision",
  inReview: "In Review",
  done: "Done",
};

/**
 * One entitlement latch for the whole process (MOV-158). The first `agent
 * sessions disabled` rejection turns the enrichment layer off for the life of
 * the daemon instead of costing one doomed mutation per issue per poll cycle.
 */
export const agentSessionCapability = createAgentSessionCapability();

export async function checkIosRunnerOnline() {
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
export async function buildRunContext(linearClient, teamKey, issues, { repairLockHeld = false } = {}) {
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
      readyForAgent: stateId(RUN_STATE_NAMES.readyForAgent),
    },
    worktreeManager,
    // MOV-180: host-wide nested-sandbox-crash breaker, persisted outside the
    // repo so it survives a dispatcher restart (see circuit-breaker.mjs).
    circuitBreaker: new CircuitBreakerStore(circuitBreakerStatePath()),
    // MOV-192: this durable store turns a sole, reset-bearing provider refusal
    // into one deferred retry instead of the no-op fallback's escalation.
    usageLimitStore: new UsageLimitStore(usageLimitStatePath()),
    // MOV-179: advisory-only diagnosis for the residual "unrecognized
    // failure" escalation bucket. diagnoseUnrecognizedFailure itself already
    // fails safe (missing ANTHROPIC_API_KEY, network error, timeout, bad
    // response all resolve to `{ ok: false }`), so this is passed straight
    // through with no extra wrapping here.
    diagnoseFailureFn: diagnoseUnrecognizedFailure,
    // MOV-190: repair has a separate durable ledger, so a daemon restart
    // cannot turn a bounded repair budget into an unbounded retry loop.
    ledger: new RepairLedger(repairLedgerStatePath()),
    // Only `dispatcher run` supplies this capability. The repair executor
    // requires it before any admission side effect, while the separate
    // `dispatcher repair --dry-run` preview stays read-only without a lock.
    lockHeldFn: () => repairLockHeld,
    enabled: autoRepairEnabled(),
    budgets: resolveRepairBudgets(),
    trustedReviewers: resolveTrustedReviewers(),
    // MOV-144: a config value above the single-flight resource policy is not
    // honored until a nonblocking supervisor exists.
    concurrencyLimit: Math.min(Number(process.env.MOVIECAL_CONCURRENCY || DEFAULT_CONCURRENCY), DEFAULT_CONCURRENCY),
    workerTimeoutMs: Number(process.env.MOVIECAL_WORKER_TIMEOUT_MS || DEFAULT_WORKER_TIMEOUT_MS),
    iosRunnerOnline: await checkIosRunnerOnline(),
    isIssueSatisfied: buildIsIssueSatisfied(issues),
    // MOV-303: forwarded to evaluatePreflight() so an incomplete issue is
    // caught at dispatch regardless of how it reached Ready for Agent.
    issueSpecMode: resolveIssueSpecMode(),
    secretPresent: () => fs.existsSync(envLocalPath()),
    worktreeRoot: worktreeRoot(),
    envLocalSource: fs.existsSync(envLocalPath()) ? envLocalPath() : undefined,
    ghRepo: GITHUB_REPO,
    logRoot: logRoot(),
    spawnWorkerFn: spawnWorker,
    // MOV-311: the machine-wide iOS simulator worker-lane lease, held for the
    // whole worker run of an "iOS Companion App" issue only (run-loop.mjs
    // gates on issue.project before ever calling these).
    acquireIosSimLeaseFn: acquireIosWorkerLease,
    releaseIosSimLeaseFn: releaseIosWorkerLease,
    auditWorkerResultFn: auditWorkerResult,
    writeWorkerAuditFn: writeWorkerAudit,
    captureVerificationEvidenceFn: captureVerificationEvidence,
    publishWorkerResultFn: (args) => publishWorkerResult({ ...args, runner: ghRunner }),
    publishRepairResultFn: (args) => publishRepairResult({ ...args, runner: ghRunner }),
    uncommittedChangesFn: (worktreePath) => worktreeManager.uncommittedChanges(worktreePath),
    localHeadShaFn: (worktreePath) => {
      try {
        return String(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" })).trim();
      } catch {
        return null;
      }
    },
    observePrFn: (prNumber, repo) => checkPrObservation(prNumber, repo, ghRunner),
    rerunFailedJobsFn: (args) => rerunFailedJobs({ ...args, runner: ghRunner }),
    collectRepairEvidenceFn: (args) => collectRepairEvidence({ ...args, runner: ghRunner }),
    commentOnPullRequestFn: (args) => commentOnPullRequest({ ...args, runner: ghRunner }),
    repositoryContextFn: (args) => collectRepositoryContext({ ...args, runner: ghRunner }),
    // Registry `id` is the human-facing MOV-NNN identifier; the Linear API
    // requires its UUID, retained as `linearIssueId` when the worktree was
    // created. Older entries without that provenance safely fail closed in
    // the repair pass rather than querying an identifier as though it were a
    // UUID.
    issueForEntryFn: (entry) => (entry.linearIssueId ? linearClient.issueSnapshot(entry.linearIssueId) : null),
    applyStagedWorkflowEditFn: (worktreePath, authorizedPath) => applyStagedWorkflowEdit(worktreePath, authorizedPath),
    // MOV-143: the route + delegate gate, and the live re-read that makes a
    // mid-flight routing/delegation change a no-op instead of a lost race.
    dispatcherDelegate: resolveDispatcherDelegate(),
    refreshIssueFn: (issue) => linearClient.issueSnapshot(issue.id),
    // MOV-158: the optional Agent Session enrichment layer, and the polling
    // stop control that works without it. The bridge is built per attempt but
    // shares one process-wide entitlement latch; with sessions off (the
    // default, and the only working configuration today) every lifecycle event
    // publishes as the app-actor comment it always did.
    agentSessionBridgeFn: () =>
      new AgentSessionBridge({
        linearClient,
        enabled: agentSessionsEnabled(),
        capability: agentSessionCapability,
      }),
    readAgentSessionFn: (issueIdentifier) => {
      try {
        return worktreeManager.loadState()[issueIdentifier]?.agentSession || null;
      } catch {
        return null;
      }
    },
    persistAgentSessionFn: (issueIdentifier, snapshot) => {
      // Best-effort bookkeeping: the registry entry may already be gone (a
      // concurrent gc), and losing it only costs the next attempt its
      // attach-vs-new-session hint, never correctness.
      try {
        worktreeManager.updateEntry(issueIdentifier, { agentSession: snapshot });
      } catch {
        /* no record to annotate */
      }
    },
    stopPollIntervalMs: Number(process.env.MOVIECAL_STOP_POLL_MS ?? DEFAULT_STOP_POLL_INTERVAL_MS),
    // MOV-214/215: off by default, and independent of agentSessionsEnabled()
    // -- steering changes the worker invocation mode, so it gets its own
    // switch rather than riding along with the receiver's.
    steeringEnabled: agentSessionSteeringEnabled(),
  };
}
