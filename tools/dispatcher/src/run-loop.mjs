// The dispatcher's core orchestration: given a batch of Linear issues in
// "Ready for Agent", run each through preflight, provision a worktree, spawn
// a worker, and report the outcome back to Linear.
//
// This module takes every dependency as an explicit parameter (no direct
// `fetch`/`child_process`/filesystem calls of its own) so the orchestration
// logic — which is the part worth getting right — is fully unit-testable
// with fakes. See bin/dispatcher.mjs for how real dependencies are wired up.

import path from "node:path";
import { evaluatePreflight, worktreeName, branchName, resolveWorkflowEditAuthorization, IOS_COMPANION_APP_PROJECT } from "./preflight.mjs";
import { resolveRouting, workerInvocation } from "./worker-routing.mjs";
import { confirmStillClaimable, evaluateLocalDispatch } from "./dispatch-eligibility.mjs";
import { generateBrief } from "./brief.mjs";
import { collectRepositoryContext } from "./repository-context.mjs";
import { tailLogs } from "./worker-spawn.mjs";
import { auditWorkerResult, writeWorkerAudit } from "./worker-guard.mjs";
import { classifyWorkerFailure, NESTED_SANDBOX_CRASH } from "./failure-classification.mjs";
import { classifyCredentialFailure, CREDENTIAL_FAILURE } from "./credential-failure.mjs";
import { classifyUsageLimitFailure, decideUsageLimitOutcome } from "./usage-limit.mjs";
import { admitUsageLimitResume } from "./usage-limit-resume.mjs";
import { LifecyclePublisher } from "./agent-lifecycle.mjs";
import { nullAgentSessionBridge } from "./agent-session.mjs";
import { StopController, detectStopFromSnapshot, watchForStop } from "./agent-signals.mjs";
import { registerActiveAttempt, unregisterActiveAttempt, updateActiveAttempt } from "./active-attempt-registry.mjs";
import { captureVerificationEvidence } from "./readiness-evidence.mjs";

/**
 * @param {object[]} issues - from LinearClient.issuesInState()
 * @param {object} ctx
 * @param {object} ctx.linearClient - LinearClient instance (or a fake with the same shape)
 * @param {Record<string,string>} ctx.stateIds - {blocked, agentWorking, needsHumanDecision, inReview, readyForAgent}, from LinearClient.workflowStates()
 * @param {object} ctx.worktreeManager - WorktreeManager instance (or a fake)
 * @param {number} ctx.concurrencyLimit
 * @param {boolean} ctx.iosRunnerOnline
 * @param {(secretName: string) => boolean} ctx.secretPresent
 * @param {(id: string) => boolean} [ctx.isIssueSatisfied] - defaults to "always satisfied"; caller should resolve real relation state before calling runOnce for a real preflight
 * @param {string} ctx.worktreeRoot
 * @param {string} [ctx.envLocalSource]
 * @param {string} ctx.ghRepo - "owner/name"
 * @param {string} ctx.logRoot
 * @param {(args: object) => Promise<{exitCode: number, logDir: string}>} ctx.spawnWorkerFn - given a `signal` (AbortSignal, MOV-138), a real
 *   implementation should kill the worker's process group when it fires; see worker-spawn.mjs.
 * @param {number} ctx.workerTimeoutMs - MOV-138: a worker that hasn't exited after this many ms is killed and its issue moved to Needs Human Decision
 * @param {(worktreePath: string) => string[]} [ctx.uncommittedChangesFn] - MOV-137; defaults to "always clean" if not provided (tests that don't care about this can omit it)
 * @param {(worktreePath: string, authorizedPath: string) => {applied: boolean, path?: string, reason?: string}} [ctx.applyStagedWorkflowEditFn] - MOV-121; defaults to a no-op if not provided (tests that don't care about this can omit it)
 * @param {'implementation'|'repair'} [ctx.workerMode] - MOV-145; repair mode has stricter protected paths and never applies staged workflow proposals
 * @param {(args: object) => object} [ctx.auditWorkerResultFn] - MOV-145; validates structured tool calls and the resulting diff before publication
 * @param {(args: {worktreePath: string, branch: string}) => object} [ctx.repositoryContextFn] - MOV-178; trusted, bounded read-only repository facts injected into the worker brief before the worker starts
 * @param {(logDir: string, report: object) => object} [ctx.writeWorkerAuditFn] - MOV-145; persists an audit record outside the worktree
 * @param {(logDir: string) => object} [ctx.captureVerificationEvidenceFn] - MOV-275; captures only completed successful verification commands from the structured transcript
 * @param {(args: object) => object} ctx.publishWorkerResultFn - MOV-145; required trusted dispatcher-side non-force push and draft PR creation
 * @param {{id?: string|null, name?: string|null}} [ctx.dispatcherDelegate] - MOV-143: the delegate an issue must name for this dispatcher to claim it; defaults to matching `moviecal-dispatcher` by name
 * @param {(issue: object) => Promise<object|null>} [ctx.refreshIssueFn] - MOV-143: re-read an issue immediately before committing to it, so a route/delegation change since the poll snapshot is a safe no-op; defaults to reusing the snapshot (tests that don't exercise the race can omit it)
 * @param {() => object} [ctx.agentSessionBridgeFn] - MOV-158: build the (feature-gated) Agent Session bridge for one attempt; defaults to a permanently-disabled bridge, so lifecycle events publish as app-actor comments exactly as they did before
 * @param {(issueIdentifier: string) => object|null} [ctx.readAgentSessionFn] - MOV-158: the prior attempt's persisted session record, used to decide attach-vs-new-linked-session; defaults to "no prior session"
 * @param {(issueIdentifier: string, snapshot: object) => void} [ctx.persistAgentSessionFn] - MOV-158: persist this attempt's session record for the next one; defaults to a no-op
 * @param {number} [ctx.stopPollIntervalMs] - MOV-158: how often to re-read the issue while a worker runs, so a de-delegation/cancellation is honoured at the next safe boundary instead of after a 45-minute worker; 0 (the default) disables the watcher entirely
 * @param {"off"|"report"|"enforce"} [ctx.issueSpecMode] - MOV-303: forwarded to `evaluatePreflight()` (preflight.mjs); `enforce` moves an incomplete issue to Blocked instead of dispatching it, naming every missing item. This is the gate every dispatched issue passes through regardless of how it reached Ready for Agent -- the promoter's own gate (promoter.mjs) only covers the ones it promoted itself. Undefined defaults to `report`, same as the promoter
 * @param {{isOpen: (name: string) => boolean, trip: (name: string, reason: string) => void, clear: (name: string) => void}} [ctx.circuitBreaker] - MOV-180/MOV-177: shared, named host-wide failure-signature breaker store (circuit-breaker.mjs), gating two independent breakers -- NESTED_SANDBOX_CRASH and CREDENTIAL_FAILURE. While either is open, `runOnce` lets exactly one issue per batch through as a half-open probe and skips the rest with outcome "circuit-breaker-open" (also applied dynamically within a batch if a breaker trips mid-cycle from an earlier issue's own outcome); defaults to a permanently-closed no-op so existing callers are unaffected
 * @param {{get: Function, record: Function, clear: Function, deferral: Function}} [ctx.usageLimitStore] - MOV-151: per-issue dispatch-time provider usage-limit record (usage-limit.mjs). Defaults to a no-op store, so a caller that does not wire it keeps today's "every non-zero exit escalates" behaviour exactly
 * @param {(issue: object) => Promise<{acquired: true, lease: object}|{acquired: false, reason: string}>} [ctx.acquireIosSimLeaseFn] - MOV-311: for an "iOS Companion App" issue only, acquire the machine-wide worker-lane simulator lease (scripts/ios-sim-lease.mjs, MOV-309) for the whole worker run. Never waits -- `acquired: false` (held by another lane, queued, or unmanaged simulator state) defers the issue silently, exactly like the usage-limit deferral above. Defaults to always-acquired-with-no-lease, so a caller that does not wire it (every non-iOS issue) is unaffected
 * @param {(leaseId: string) => Promise<void>} [ctx.releaseIosSimLeaseFn] - MOV-311: releases the lease `acquireIosSimLeaseFn` returned, called from the one `processIssue` chokepoint that wraps every terminal path of `dispatchIssue`. Defaults to a no-op
 * @param {(args: {exitCode: number, logTail: string, auditText: string}) => Promise<{ok: true, confident: boolean, diagnosis: string, evidence: string|null}|{ok: false, reason: string}>} [ctx.diagnoseFailureFn] - MOV-179: advisory-only, single bounded call that writes a grounded diagnosis into the residual "unrecognized failure" `Needs Human Decision` comment (worker-diagnosis.mjs). Never changes whether or how an issue escalates -- any failure, rejection, or missing wiring falls back to today's plain comment. Only called for failures with no dedicated classification of their own (not rate-limit, not credential-failure, not a security-policy block); defaults to a no-op that always reports no diagnosis
 * @returns {Promise<Array<{issue: string, outcome: string, [key: string]: unknown}>>}
 */
// MOV-180/MOV-177: the host-wide breakers that gate *dispatch* (never the
// rest of a poll cycle — reconcile/parent/priority-propagation/promote all
// run as separate calls in bin/dispatcher.mjs's cmdRunOnce that never consult
// this store). Both share the one CircuitBreakerStore, which is keyed by name
// for exactly this reason (see circuit-breaker.mjs), so listing them here is
// the only change needed to gate dispatch on a new breaker.
const DISPATCH_BREAKERS = [NESTED_SANDBOX_CRASH, CREDENTIAL_FAILURE];

export async function runOnce(issues, ctx) {
  const {
    concurrencyLimit,
    worktreeManager,
    circuitBreaker = { isOpen: () => false, trip: () => {}, clear: () => {} },
  } = ctx;

  // MOV-180: once tripped, let exactly one issue in this batch through as a
  // probe of whether the host-wide condition has cleared — a standard
  // half-open circuit-breaker state — and skip everything else without
  // touching the worktree manager or Linear at all. Gating per-batch here
  // (rather than per-issue inside processIssue) is what makes "closes once a
  // subsequent run succeeds" possible: a check inside processIssue would also
  // block the very probe attempt that could clear it, since the breaker is
  // only cleared *after* that attempt's worker finishes.
  const openBreakersAtStart = DISPATCH_BREAKERS.filter((name) => circuitBreaker.isOpen(name));
  const breakerOpenAtStart = openBreakersAtStart.length > 0;
  let probeClaimed = false;

  // MOV-138: bound how many `processIssue` calls run concurrently within this
  // batch to the slots this cycle can actually use — the concurrency limit
  // minus whatever's already active from earlier cycles, floored at 1 so an
  // over-subscribed cycle still runs each issue through preflight (which
  // reports the real "blocked" outcome) instead of deadlocking. Sized once
  // up front: within a batch, active-worktree count can only fall (as issues
  // finish) not rise from outside this loop, so a fixed-size pool exactly
  // tracks the slots preflight's own live check will grant as issues finish
  // and free a slot for the next queued one.
  const poolSize = Math.max(1, concurrencyLimit - worktreeManager.activeCount());
  let availablePermits = poolSize;
  const waiters = [];
  const acquire = () =>
    new Promise((resolve) => {
      if (availablePermits > 0) {
        availablePermits -= 1;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else availablePermits += 1;
  };

  const results = new Array(issues.length);
  await Promise.all(
    issues.map(async (issue, index) => {
      if (breakerOpenAtStart) {
        // Synchronous check-and-set, no `await` in between: only the first
        // entrant to reach this point claims the probe slot, regardless of
        // how many issues are in the batch.
        if (probeClaimed) {
          results[index] = { issue: issue.identifier, outcome: "circuit-breaker-open", reason: openBreakersAtStart.join(", ") };
          return;
        }
        probeClaimed = true;
      }
      await acquire();
      // MOV-177: a breaker that was closed when this batch started can still
      // trip mid-batch, from an earlier issue in this very same cycle
      // finishing its worker and hitting a host-wide failure signature.
      // Without this recheck, a dead credential burns through the rest of
      // the batch one issue at a time — each later issue's own preflight
      // concurrency check passes again the moment the prior one is marked
      // "failed" — which is exactly the failure mode this issue exists to
      // close. Only relevant when the breaker was *not* already open at the
      // start; that case is the half-open probe above.
      if (!breakerOpenAtStart) {
        const trippedDuringBatch = DISPATCH_BREAKERS.filter((name) => circuitBreaker.isOpen(name));
        if (trippedDuringBatch.length > 0) {
          results[index] = { issue: issue.identifier, outcome: "circuit-breaker-open", reason: trippedDuringBatch.join(", ") };
          release();
          return;
        }
      }
      try {
        results[index] = await processIssue(issue, ctx);
      } finally {
        release();
        // MOV-166: this issue is no longer a live attempt an inbound signal
        // could apply to, whether or not it ever actually got as far as
        // registerActiveAttempt() (unregistering something never registered
        // is a no-op).
        unregisterActiveAttempt(issue.id);
      }
    }),
  );
  return results;
}

/**
 * MOV-151: the default when a caller wires no usage-limit store. Every
 * method is inert and `deferral` never defers, so an unwired caller keeps
 * today's behaviour — every non-zero worker exit escalates immediately.
 */
const NO_USAGE_LIMIT_STORE = Object.freeze({
  get: () => null,
  record: () => null,
  clear: () => {},
  deferral: () => ({ deferred: false, until: null, reason: null }),
  resumption: () => null,
  consumeResume: () => null,
});

/**
 * MOV-179: the default when a caller wires no diagnosis adapter — always
 * "no diagnosis available", so an unwired caller keeps today's plain
 * escalation comment exactly as before.
 */
async function NO_DIAGNOSIS() {
  return { ok: false, reason: "diagnosis adapter not configured" };
}

/**
 * MOV-179: call the (advisory-only) diagnosis adapter for an unrecognized
 * failure and turn its result into the comment section to splice in ahead of
 * the raw log dump every one of these escalations already prints.
 *
 * This never blocks or fails the escalation itself: any throw, rejection, or
 * `{ ok: false }` result from the adapter — a missing key, a timeout, a rate
 * limit, a malformed response — is swallowed here and produces no section at
 * all, so the caller falls through to exactly today's plain comment. The
 * adapter is called at most once; there is no retry loop.
 */
async function diagnosisSections(diagnoseFailureFn, args) {
  let result;
  try {
    result = await diagnoseFailureFn(args);
  } catch {
    return [];
  }
  if (!result || result.ok !== true || typeof result.diagnosis !== "string" || !result.diagnosis.trim()) {
    return [];
  }
  const label = result.confident
    ? "**Diagnosis (advisory, not verified):**"
    : "**Diagnosis (advisory, not verified) — not confident:**";
  return [
    label,
    result.diagnosis.trim(),
    ...(result.evidence ? ["", `Evidence: \`${result.evidence}\``] : []),
    "",
    "_Generated by one bounded, single-shot model call over this run's own transcript. It is advisory only: it does not change whether this issue escalates, and nothing here retries or resolves the failure automatically — see docs/operators/local-execution.md §Security model._",
    "",
  ];
}

/**
 * Read a live fact off the worktree manager, treating "this manager does not
 * implement it" and "it threw" identically as *unknown* (MOV-205).
 *
 * Every caller below feeds the result into `admitUsageLimitResume()`, whose
 * refusals are all fail-closed — so an unknown fact refuses the resume rather
 * than waving it through. That is the correct reading for both cases: a test
 * double or an older manager that cannot prove ownership has not proven it,
 * and a `git` invocation that threw has not proven anything either.
 */
function probe(fn, fallback) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Spend this issue's scheduled resume so it can never fire twice (MOV-205).
 *
 * Called on **both** outcomes — admitted and refused. An unspent plan whose
 * reset is already in the past is due on every subsequent poll, which would
 * either start a second worker against the same worktree or re-escalate the
 * same refusal into Linear every 30 seconds.
 *
 * Returns false when the store cannot prove the plan is spent, which the
 * caller must treat exactly like a failed re-admission: without that proof the
 * "exactly one resume" bound does not exist, and an unbounded resume loop is
 * strictly worse than asking a human. The hard `clear()` below is the
 * last-resort stop for that case — it costs the consecutive counter, which
 * only matters on a path that is escalating to a human anyway.
 */
function spendScheduledResume(store, issueId, now) {
  try {
    const consumed = typeof store.consumeResume === "function" ? store.consumeResume(issueId, { now }) : null;
    const stillDue = typeof store.resumption === "function" ? store.resumption(issueId, now) : null;
    if (consumed && !stillDue) return true;
  } catch {
    // fall through to the hard clear
  }
  try {
    store.clear(issueId);
  } catch {
    // nothing durable to clear; the refusal below is still reported
  }
  return false;
}

const WORKER_TIMEOUT = Symbol("worker-timeout");
/** MOV-158: a stop was observed while the worker ran, and the worker's process group was killed. */
const WORKER_STOPPED = Symbol("worker-stopped");

/** Race a worker's promise against a timeout, resolving to WORKER_TIMEOUT if the timer wins. */
function raceWorkerTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(WORKER_TIMEOUT), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * MOV-214/215: the steering turn-loop. Runs alongside the worker/stop/timeout
 * race (never awaited by it), and is the *only* thing that ever calls the
 * real `spawnWorker()`-returned `writeTurn`/`requestClose` -- a trusted
 * prompt arriving mid-turn only ever reaches `promptQueue` (see
 * `agent-stream-client.mjs`'s `queuePrompt`), and is written as the worker's
 * next turn at its next turn boundary, never spliced into one already in
 * progress.
 *
 * With nothing ever queued, this closes stdin at the very first boundary --
 * identical timing to today's exact one-shot behavior. `signal` stops the
 * loop from acting once the attempt has otherwise settled (killed by a
 * timeout or a stop); the worker process itself is what actually exits
 * either way, so a stopped loop changes nothing about correctness, only
 * about not calling into a handle whose usefulness has already ended.
 */
async function runSteeringTurnLoop(spawned, promptQueue, signal) {
  while (!signal.aborted) {
    const boundary = await spawned.nextTurnBoundary();
    if (boundary.ended || signal.aborted) return;
    if (promptQueue.pending !== null) {
      const text = promptQueue.pending;
      promptQueue.pending = null;
      spawned.writeTurn(text);
    } else {
      spawned.requestClose();
      return;
    }
  }
}

/**
 * MOV-311: an "iOS Companion App" issue needs the machine-wide worker-lane
 * simulator lease (MOV-309) for its whole worker run. Acquisition never
 * waits (see ctx.acquireIosSimLeaseFn) -- a lease unavailable right now,
 * whatever the reason, is ordinary infrastructure contention, not a dispatch
 * failure: the issue is deferred silently, exactly like the usage-limit
 * deferral above, and a later poll cycle retries once it frees. Wrapping
 * `dispatchIssue` here (rather than threading acquire/release through its
 * many existing early-return paths) is what makes "released on every
 * terminal path" a single chokepoint instead of N call sites.
 */
async function processIssue(issue, ctx) {
  const {
    acquireIosSimLeaseFn = async () => ({ acquired: true, lease: null }),
    releaseIosSimLeaseFn = async () => {},
    logger = console,
  } = ctx;

  if (issue.project !== IOS_COMPANION_APP_PROJECT) {
    return dispatchIssue(issue, ctx);
  }

  const attempt = await acquireIosSimLeaseFn(issue);
  if (!attempt.acquired) {
    return { issue: issue.identifier, outcome: "deferred-ios-sim-lease", reason: attempt.reason };
  }

  try {
    return await dispatchIssue(issue, { ...ctx, iosSimLeaseId: attempt.lease.id });
  } finally {
    try {
      await releaseIosSimLeaseFn(attempt.lease.id);
    } catch (error) {
      logger.error(`Could not release iOS simulator worker lease ${attempt.lease.id} for ${issue.identifier}: ${error.message}`);
    }
  }
}

async function dispatchIssue(issue, ctx) {
  const {
    linearClient,
    stateIds,
    worktreeManager,
    concurrencyLimit,
    iosRunnerOnline,
    secretPresent,
    isIssueSatisfied = () => true,
    worktreeRoot,
    envLocalSource,
    ghRepo,
    logRoot,
    spawnWorkerFn,
    workerTimeoutMs,
    uncommittedChangesFn = () => [],
    applyStagedWorkflowEditFn = () => ({ applied: false, reason: "not configured" }),
    workerMode = "implementation",
    auditWorkerResultFn = auditWorkerResult,
    repositoryContextFn = collectRepositoryContext,
    writeWorkerAuditFn = writeWorkerAudit,
    captureVerificationEvidenceFn = captureVerificationEvidence,
    publishWorkerResultFn,
    dispatcherDelegate = {},
    refreshIssueFn = async (snapshot) => snapshot,
    agentSessionBridgeFn = () => nullAgentSessionBridge(),
    readAgentSessionFn = () => null,
    persistAgentSessionFn = () => {},
    stopPollIntervalMs = 0,
    circuitBreaker = { isOpen: () => false, trip: () => {}, clear: () => {} },
    usageLimitStore = NO_USAGE_LIMIT_STORE,
    diagnoseFailureFn = NO_DIAGNOSIS,
    steeringEnabled = false,
    now = () => new Date(),
    logger = console,
    issueSpecMode,
    iosSimLeaseId = null,
  } = ctx;

  // MOV-143: before anything else, is this issue even ours? An issue routed to
  // another adapter, routed nowhere (coordination), or delegated to somebody
  // else is not this dispatcher's to claim *or* to comment on — skipping is
  // silent by design, since a poll cycle every 30s would otherwise narrate its
  // own restraint forever. Only an issue delegated here can be escalated by
  // here, because only then is this dispatcher that issue's writer.
  const eligibility = evaluateLocalDispatch(issue, { expectedDelegate: dispatcherDelegate });
  if (!eligibility.eligible) {
    if (eligibility.action === "escalate") {
      await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
      await linearClient.addComment(
        issue.id,
        [
          `**Dispatcher cannot execute this issue:** ${eligibility.reason}`,
          "",
          "The local Mac dispatcher only claims issues that carry exactly one valid `execution:mac` label and are delegated to `moviecal-dispatcher`. Fix the route (or re-delegate the issue) and move it back to `Ready for Agent`.",
          "",
          "See docs/operators/local-execution.md §Dispatch trigger.",
        ].join("\n"),
      );
      return { issue: issue.identifier, outcome: "needs-human", reason: eligibility.reason };
    }
    return { issue: issue.identifier, outcome: "not-eligible", reason: eligibility.reason };
  }

  // MOV-151: this issue's previous attempt died at dispatch time because the
  // provider refused the session, and a retry is already scheduled for the
  // reset time it named. Hold off until then — and silently: the reason was
  // published to Linear once when the retry was scheduled, and repeating it
  // every 30-second poll would bury it. Checked here, before preflight, so a
  // parked issue neither claims a concurrency slot nor writes a `Blocked`
  // comment on its way past one.
  const deferral = usageLimitStore.deferral(issue.identifier, now());
  if (deferral.deferred) {
    return { issue: issue.identifier, outcome: "deferred-usage-limit", reason: deferral.reason, retryAt: deferral.until };
  }

  const name = worktreeName(issue.identifier, issue.title);
  const branch = branchName(issue.identifier, issue.title);
  const candidatePath = path.join(worktreeRoot, name);

  // MOV-205: the deferral above has lapsed — is this issue due for a *resume*
  // of its own retained worktree, rather than an ordinary fresh dispatch? Read
  // once, here, because the answer changes what "preflight" even means for
  // this pass (see the worktree-path gate below).
  const resumePlan = probe(() => usageLimitStore.resumption?.(issue.identifier, now()), null);

  const preflight = evaluatePreflight(issue, {
    isIssueSatisfied,
    iosRunnerOnline,
    activeWorktreeCount: worktreeManager.activeCount(),
    concurrencyLimit,
    secretPresent,
    issueSpecMode,
    // MOV-181: reclaims a retained worktree from this same issue's own
    // prior terminal (failed/abandoned/merged) attempt, so a requeued issue
    // isn't blocked by its own retention window. See
    // WorktreeManager.isPathFreeForIssue for why this must not be used in
    // the dry-run preview (dispatcher.mjs deliberately keeps plain
    // isPathFree there instead).
    //
    // MOV-185: when the reclaim was refused because the worktree is dirty,
    // surface WorktreeManager's specific reason instead of the generic
    // "already in use" message, so the resulting Blocked comment names the
    // dirty path instead of looking like an ordinary collision. Guarded with
    // a feature check so a test double that doesn't implement
    // reclaimBlockedReason (most of run-loop.test.mjs's fakes) still gets
    // the plain boolean it always has.
    //
    // MOV-205: for a scheduled resume the retained worktree *is* the dispatch
    // target, so "the path must be unused" is the wrong question — and asking
    // the MOV-181 version of it would be actively dangerous, since a reclaim
    // is a real `git worktree remove`. The gate is not relaxed here, it is
    // replaced: `admitUsageLimitResume()` below re-proves ownership,
    // integrity, branch/repository identity, registry provenance, and that
    // the unpublished work is still present, all of which the plain
    // collision check never checked at all.
    worktreePathFree: resumePlan
      ? () => true
      : (p) => {
          const free = worktreeManager.isPathFreeForIssue(p, issue.identifier);
          if (free || typeof worktreeManager.reclaimBlockedReason !== "function") return free;
          return worktreeManager.reclaimBlockedReason(p, issue.identifier) ?? false;
        },
    candidateWorktreePath: candidatePath,
  });

  if (!preflight.ok) {
    await linearClient.moveToState(issue.id, stateIds.blocked);
    await linearClient.addComment(issue.id, `**Dispatcher preflight failed:** ${preflight.reason}`);
    return { issue: issue.identifier, outcome: "blocked", reason: preflight.reason };
  }

  const routing = resolveRouting(issue);
  if (!routing.ok) {
    await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
    await linearClient.addComment(issue.id, `**Dispatcher routing failed:** ${routing.reason}`);
    return { issue: issue.identifier, outcome: "needs-human", reason: routing.reason };
  }

  // MOV-143: last check before this becomes irreversible. Everything above
  // reasoned about the poll snapshot, and a human can change an issue's route,
  // its delegate, or its workflow state at any point in between — including
  // while a queued issue waited for a concurrency slot, which can be the whole
  // length of another worker's run. Re-read and re-decide. Losing that race is
  // a no-op: no worktree, no state change, no comment. The issue is not
  // "claimed" until the worktree exists; the `Agent Working` transition below
  // reports that claim, it does not constitute one (Linear offers no
  // compare-and-set on workflow state, so it could never be a lock).
  let fresh;
  try {
    fresh = await refreshIssueFn(issue);
  } catch (err) {
    // Fail closed, and only for this issue: a transient Linear error means we
    // cannot show the issue is still ours, which is not the same as showing it
    // is. Rethrowing would abort every other issue in the batch too.
    return {
      issue: issue.identifier,
      outcome: "not-eligible",
      reason: `could not re-read the issue before starting: ${err.message}`,
    };
  }
  // MOV-158: the same re-read is also the first safe interruption boundary. A
  // de-delegation, cancellation, or incompatible state observed here halts the
  // attempt before anything exists to clean up, and — because this dispatcher
  // is no longer that issue's writer — silently.
  const stopController = new StopController();
  const stillClaimable = confirmStillClaimable(fresh, { expectedDelegate: dispatcherDelegate });
  if (!stillClaimable.claimable) {
    stopController.request({ source: "polling", reason: stillClaimable.reason, detail: null, mayWrite: false });
  }
  if (stopController.checkpoint("before-claim").halt) {
    return { issue: issue.identifier, outcome: "not-eligible", reason: stopController.stopRequest.reason };
  }

  // MOV-205: exactly one of these two ways to obtain a worktree runs. A
  // scheduled resume re-opens the retained one in place and never calls
  // `create()`; everything else creates a fresh one and never calls
  // `resumeEntry()`. Keeping them mutually exclusive here — rather than
  // branching somewhere deeper — is what makes "no reclaim, no new worktree,
  // no branch deletion on the resume path" checkable by reading one block.
  let entry;
  let resume = null;
  if (resumePlan) {
    const admission = admitUsageLimitResume({
      issueId: issue.identifier,
      plan: resumePlan,
      entry: probe(() => worktreeManager.loadState?.()?.[issue.identifier] ?? null, null),
      repository: ghRepo,
      branch,
      worktreePath: candidatePath,
      dispatcherOwned: probe(() => worktreeManager.isDispatcherOwnedWorktree?.(candidatePath) ?? false, false),
      integrity: probe(() => worktreeManager.worktreeIntegrity?.(candidatePath, branch) ?? null, null),
      unpublishedPaths: probe(() => uncommittedChangesFn(candidatePath), []),
    });

    // Spend the plan on both outcomes, and treat an unprovable spend as a
    // refusal of its own — see spendScheduledResume().
    const spent = spendScheduledResume(usageLimitStore, issue.identifier, now());
    const refusal = !admission.admitted
      ? admission.reason
      : !spent
        ? "the scheduled resume could not be marked spent durably, so it cannot be guaranteed to happen only once"
        : null;

    if (refusal) {
      await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
      await linearClient.addComment(
        issue.id,
        [
          "**Scheduled resume of the retained worktree was refused (MOV-205).**",
          "",
          `Reason: ${refusal}`,
          "",
          `Retained worktree: \`${candidatePath}\``,
          `Branch: \`${branch}\``,
          `Scheduled resume was: **${resumePlan.retryAt}**`,
          "",
          "The worktree was **not** reclaimed, removed, or replaced, and no worker ran. Inspect it, recover or discard the unpublished work by hand, and move this issue back to `Ready for Agent` when it is safe to dispatch again.",
          "",
          "See docs/operators/local-execution.md §Worktree lifecycle.",
        ].join("\n"),
      );
      return {
        issue: issue.identifier,
        outcome: "needs-human",
        reason: refusal,
        usageLimitResume: "refused",
      };
    }

    try {
      entry = worktreeManager.resumeEntry(issue.identifier, { worktreePath: candidatePath, branch });
    } catch (err) {
      await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
      await linearClient.addComment(
        issue.id,
        [
          "**Scheduled resume of the retained worktree could not be re-opened (MOV-205).**",
          "",
          `Reason: ${err.message}`,
          "",
          `Retained worktree: \`${candidatePath}\``,
          "",
          "The worktree was left exactly as it was; no worker ran and nothing was removed.",
        ].join("\n"),
      );
      return {
        issue: issue.identifier,
        outcome: "needs-human",
        reason: `retained worktree could not be re-opened for a resume: ${err.message}`,
        usageLimitResume: "refused",
      };
    }
    resume = {
      retryAt: resumePlan.retryAt,
      unpublishedPaths: resumePlan.unpublishedPaths || [],
      consecutive: resumePlan.consecutive || 1,
    };
  } else {
    entry = worktreeManager.create({
      id: issue.identifier,
      name,
      branch,
      worker: routing.worker,
      model: routing.model,
      linearUrl: issue.url,
      linearIssueId: issue.id,
      envLocalSource,
      repository: ghRepo,
    });
  }

  // MOV-311: persisted on the registry entry (not just held in this closure)
  // so a dispatcher crash mid-run can still release it — startup recovery
  // reads it back off the abandoned entry (worktree-manager.mjs, startup-recovery.mjs).
  if (iosSimLeaseId && typeof worktreeManager.setIosSimLeaseId === "function") {
    worktreeManager.setIosSimLeaseId(issue.identifier, iosSimLeaseId);
  }

  // Everything from here on is published through one lifecycle surface
  // (MOV-158): a first-class Agent Activity when sessions are available, and
  // the same app-actor comment the dispatcher has always written when they are
  // not — which is every run today (MOV-141). Workflow-state transitions are
  // written either way; they are control data, not presentation.
  const publisher = new LifecyclePublisher({
    linearClient,
    bridge: agentSessionBridgeFn(),
    logger,
    context: {
      issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
      branch,
      worktreePath: entry.path,
      worker: routing.worker,
      model: routing.model,
    },
  });
  await publisher.begin({ existing: readAgentSessionFn(issue.identifier) });

  // MOV-166: makes this attempt findable by issue id for an inbound Agent
  // Session signal (the stream client looks it up to route a stop to the
  // right StopController, or a trusted prompt to `publisher` / a live
  // worker's `writeTurn`, once one is registered below). Unregistered in
  // `runOnce()`'s existing per-issue try/finally, alongside `release()`.
  registerActiveAttempt(issue.id, { identifier: issue.identifier, controller: stopController, publisher });

  try {
    return await runClaimedAttempt({
      issue,
      entry,
      branch,
      routing,
      publisher,
      stopController,
      resume,
      ctx: {
        stateIds,
        worktreeManager,
        ghRepo,
        logRoot,
        spawnWorkerFn,
        workerTimeoutMs,
        uncommittedChangesFn,
        applyStagedWorkflowEditFn,
        workerMode,
        auditWorkerResultFn,
        repositoryContextFn,
        writeWorkerAuditFn,
        captureVerificationEvidenceFn,
        publishWorkerResultFn,
        dispatcherDelegate,
        refreshIssueFn,
        stopPollIntervalMs,
        circuitBreaker,
        iosSimLeaseId,
        usageLimitStore,
        diagnoseFailureFn,
        steeringEnabled,
        now,
        logger,
      },
    });
  } finally {
    // Non-fatal bookkeeping, and deliberately in a `finally`: the session
    // record must survive every exit path, including the failure ones, or the
    // next attempt cannot tell "resume this" from "open a new linked session".
    //
    // The retry queue is the one thing a stop can forbid. Flushing it writes
    // activities to the issue, so an attempt stopped *without* write permission
    // (its delegation was removed — we are not that issue's writer any more)
    // must drop the queue rather than let a transient failure earlier in the
    // run turn into a write after the boundary.
    const stoppedSilently = stopController.stopped && !stopController.stopRequest.mayWrite;
    if (!stoppedSilently) {
      try {
        await publisher.flushPending();
      } catch (error) {
        logger.error(`Could not flush queued Agent Activities for ${issue.identifier}: ${error.message}`);
      }
    }
    try {
      persistAgentSessionFn(issue.identifier, publisher.snapshot());
    } catch (error) {
      logger.error(`Could not persist the Agent Session record for ${issue.identifier}: ${error.message}`);
    }
  }
}

/**
 * Report a stop and halt. The dispatcher writes **at most one** thing after a
 * stop: an explanation of why it stopped, and only when it is still the
 * issue's writer. A stop that came from a removed delegation writes nothing at
 * all — commenting on an issue that is no longer ours is the boundary
 * violation `dispatch-eligibility.mjs` exists to prevent.
 *
 * The issue's workflow state is deliberately left alone. Whoever stopped the
 * work already decided where it should sit; moving it would overwrite that.
 */
async function reportStop(request, { issue, publisher, worktreeManager }) {
  worktreeManager.markStatus(issue.identifier, "abandoned", { stopReason: request.reason });
  if (request.mayWrite) {
    await publisher.publish("stopped", {
      summary: `Dispatcher stopped work on ${issue.identifier}: ${request.reason}`,
      headline: "**Dispatcher stopped at a safe interruption boundary.**",
      sections: [
        `Reason: ${request.reason}`,
        request.detail ? `Detail: ${request.detail}` : null,
        `Signal source: ${request.source}`,
        "",
        "No further changes were made and no further writes will be made for this attempt. The branch and any pushed commits are untouched; the worktree is retained for 7 days.",
      ].filter(Boolean),
    });
  }
  return {
    issue: issue.identifier,
    outcome: "stopped",
    reason: request.reason,
    source: request.source,
    reported: Boolean(request.mayWrite),
  };
}

/**
 * The claimed half of an attempt: the worktree exists, so from here every exit
 * has to leave the registry and the Linear issue in a coherent state.
 *
 * `resume` (MOV-205) is non-null when this attempt is continuing in a retained
 * worktree after a provider usage-limit reset rather than starting in a fresh
 * one. It changes only what is *reported* — the lifecycle evidence and the
 * worker's brief say so explicitly — never how the attempt is spawned,
 * audited, or published: a resumed worker goes through the identical safety
 * boundary as any other implementation worker, deliberately.
 */
async function runClaimedAttempt({ issue, entry, branch, routing, publisher, stopController, resume = null, ctx }) {
  const {
    stateIds,
    worktreeManager,
    ghRepo,
    logRoot,
    spawnWorkerFn,
    workerTimeoutMs,
    uncommittedChangesFn,
    applyStagedWorkflowEditFn,
    workerMode,
    auditWorkerResultFn,
    repositoryContextFn,
    writeWorkerAuditFn,
    captureVerificationEvidenceFn,
    publishWorkerResultFn,
    dispatcherDelegate,
    refreshIssueFn,
    stopPollIntervalMs,
    circuitBreaker,
    usageLimitStore,
    diagnoseFailureFn = NO_DIAGNOSIS,
    // MOV-214/215: live mid-run prompt delivery, off by default and Claude-only
    // (see workerInvocation()/spawnWorker()'s own steering gates). With this
    // false -- today's default -- everything below behaves exactly as before.
    steeringEnabled = false,
    now,
    logger,
    iosSimLeaseId = null,
  } = ctx;

  await publisher.publish("acknowledged", {
    stateId: stateIds.agentWorking,
    summary: resume
      ? `Dispatcher resumed ${issue.identifier} in its retained worktree after the provider usage limit reset.`
      : `Dispatcher picked up ${issue.identifier} on the local Mac adapter.`,
    headline: resume
      ? "**Dispatcher resumed the retained worktree after a provider usage-limit reset (MOV-205).**"
      : "**Dispatcher started work.**",
    sections: [
      `Worktree: \`${entry.path}\`${resume ? " — the same worktree the deferred attempt left behind; it was not reclaimed, removed, or recreated" : ""}`,
      `Branch: \`${branch}\``,
      `Worker: ${routing.worker} (model: ${routing.model})`,
      ...(resume
        ? [
            "",
            `Scheduled resume: **${resume.retryAt}** (this attempt is the single bounded resume; a further provider limit escalates to \`Needs Human Decision\`).`,
            "",
            "Unpublished paths carried into this attempt:",
            "```",
            ...(resume.unpublishedPaths.length ? resume.unpublishedPaths : ["_(none recorded)_"]),
            "```",
            "",
            "Dispatcher ownership, worktree integrity, branch and repository identity, and registry provenance were all re-validated before this worker started.",
          ]
        : []),
    ],
  });

  /**
   * Re-read the issue and decide whether a human has taken it away from us.
   * Returns null — "keep going" — on any error, because a transient Linear
   * failure is not a human asking to halt.
   */
  const observeStop = async () => {
    let snapshot;
    try {
      snapshot = await refreshIssueFn(issue);
    } catch (error) {
      logger.error(`Stop poll for ${issue.identifier} could not re-read the issue (continuing): ${error.message}`);
      return null;
    }
    return detectStopFromSnapshot(snapshot, { expectedDelegate: dispatcherDelegate });
  };

  const repositoryContext = repositoryContextFn({ worktreePath: entry.path, branch });
  const brief = generateBrief(issue, {
    branch,
    worktreePath: entry.path,
    worker: routing.worker,
    model: routing.model,
    upgradeConditions: routing.upgradeConditions,
    repositoryContext,
    resume,
  });
  // MOV-214/215: steering only ever applies to the Claude worker -- Codex has
  // no equivalent interactive protocol, and workerInvocation()/spawnWorker()
  // both silently ignore the option for it, but computing it once here keeps
  // this function's own branching (registry registration, the turn-loop)
  // from having to repeat that condition.
  const steeringActive = steeringEnabled && routing.worker === "claude";
  const invocation = workerInvocation(routing.worker, routing.model, { steering: steeringActive });
  const logDir = path.join(logRoot, entry.name);

  // Two abort controllers with different jobs: `abortController` kills the
  // worker's process group (MOV-137/138), `watcherAbort` retires the stop
  // watcher once the worker has settled so no timer outlives the attempt.
  const abortController = new AbortController();
  const watcherAbort = new AbortController();
  let spawnResult;
  try {
    // Real WorktreeManager instances always provide this durable handoff.
    // Keep dependency-injected legacy test doubles compatible; they never
    // spawn a real child and therefore cannot represent the crash window.
    worktreeManager.prepareWorkerSpawn?.(issue.identifier);
    const spawned = spawnWorkerFn({
      invocation,
      cwd: entry.path,
      brief,
      logDir,
      signal: abortController.signal,
      securityContext: { mode: workerMode },
      steering: steeringActive,
      iosSimLeaseId,
      // `spawnWorker()` invokes this before the brief can start work. The
      // stored pid is also the detached process-group id, allowing a
      // replacement dispatcher to terminate the complete worker tree before
      // it reclaims this path (MOV-254).
      onSpawn: ({ pid }) => {
        if (!pid) throw new Error("worker spawn did not provide a process-group leader pid");
        worktreeManager.setWorkerPid(issue.identifier, pid);
      },
    });
    // Without steering, spawnWorkerFn returns a bare Promise, exactly as
    // before. With it, spawnWorkerFn returns {promise, writeTurn,
    // requestClose, nextTurnBoundary} -- workerPromise is the one thing every
    // path below still races/awaits identically either way.
    const workerPromise = steeringActive ? spawned.promise : spawned;
    if (steeringActive) {
      // A single-slot queue: `agent-stream-client.mjs` only ever calls
      // `queuePrompt`, never the real writeTurn directly, so a prompt can
      // never be spliced into a turn already in progress -- the turn-loop
      // below is the only thing that writes it, at a turn boundary.
      const promptQueue = { pending: null };
      updateActiveAttempt(issue.id, { queuePrompt: (text) => { promptQueue.pending = text; } });
      // Fire-and-forget: this loop's own lifetime is bounded by the worker
      // process exiting (nextTurnBoundary() resolves {ended:true} once it
      // does) or watcherAbort firing once this attempt has otherwise settled.
      runSteeringTurnLoop(spawned, promptQueue, watcherAbort.signal).catch((err) => {
        logger.error(`Steering turn-loop for ${issue.identifier} failed (worker continues unaffected): ${err.message}`);
      });
    }
    // The race below owns this rejection; these no-op handlers only stop Node
    // reporting the loser of the race as an unhandled rejection.
    Promise.resolve(workerPromise).catch(() => {});
    const stopPromise = watchForStop({
      controller: stopController,
      observeStopFn: observeStop,
      intervalMs: stopPollIntervalMs,
      signal: watcherAbort.signal,
    }).then((request) => (request ? WORKER_STOPPED : workerPromise));
    stopPromise.catch(() => {});
    spawnResult = await raceWorkerTimeout(Promise.race([workerPromise, stopPromise]), workerTimeoutMs);
  } catch (err) {
    const violation = {
      action: "worker safety boundary",
      reason: `worker could not start under the required safety boundary: ${err.message}`,
    };
    let spawnAuditRecord;
    try {
      spawnAuditRecord = writeWorkerAuditFn(logDir, {
        issue: issue.identifier,
        worker: routing.worker,
        phase: "spawn",
        ok: false,
        violations: [violation],
      });
    } catch {
      // The Linear record below remains the final audit backstop if the local
      // filesystem is itself unavailable. Never weaken the fail-closed path.
    }
    worktreeManager.markStatus(issue.identifier, "failed");
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: `Dispatcher failed to start the worker under the required safety boundary: ${err.message}`,
      headline: `**Dispatcher failed to start the worker under the required safety boundary:** ${err.message}`,
      sections: [
        `Audit record: \`${spawnAuditRecord?.path || logDir}\`${spawnAuditRecord?.sha256 ? ` (SHA-256 \`${spawnAuditRecord.sha256}\`)` : ""}`,
        "",
        "The issue was moved to `Needs Human Decision`; no worker ran and no remote mutation was attempted.",
      ],
    });
    return { issue: issue.identifier, outcome: "spawn-error", error: err.message };
  } finally {
    watcherAbort.abort();
  }

  if (spawnResult === WORKER_STOPPED) {
    // MOV-158, `during-worker` boundary: a human took the issue away while the
    // worker ran. Kill its process group the same way a timeout does, then
    // honour the stop at a boundary rather than mid-edit.
    //
    // The return is unconditional, not gated on `halt`. `WORKER_STOPPED` is
    // only ever produced *because* a stop was recorded, so `halt` is true by
    // construction — but falling through with a Symbol in `spawnResult` would
    // read `spawnResult.exitCode` as `undefined` and misreport a stopped
    // attempt as `worker-failed`. Structure it so that cannot happen.
    abortController.abort();
    stopController.checkpoint("during-worker");
    return reportStop(stopController.stopRequest, { issue, publisher, worktreeManager });
  }

  if (spawnResult === WORKER_TIMEOUT) {
    // MOV-138: kill the worker's process group (reuses MOV-137's group-kill
    // in worker-spawn.mjs, triggered by the abort signal) and hand off to a
    // human rather than let a hang (MOV-106) freeze the rest of the batch.
    abortController.abort();
    // A worker that ran long enough to time out was granted a provider
    // session, so any earlier usage-limit history is not consecutive (MOV-151).
    usageLimitStore.clear(issue.identifier);
    worktreeManager.markStatus(issue.identifier, "failed");
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: `Worker timed out after ${workerTimeoutMs}ms and was killed.`,
      headline: `**Worker timed out after ${workerTimeoutMs}ms and was killed.**`,
      sections: ["```", tailLogs(logDir, 30), "```", "", `Full run log: \`${logDir}\``],
    });
    return { issue: issue.identifier, outcome: "timeout", timeoutMs: workerTimeoutMs };
  }

  // MOV-158, `after-worker` boundary: the worker has exited and nothing has
  // been reported yet, so honouring a stop here costs no completed work.
  if (stopController.checkpoint("after-worker").halt) {
    return reportStop(stopController.stopRequest, { issue, publisher, worktreeManager });
  }

  let securityReport;
  let auditRecord;
  let verificationEvidence;
  try {
    securityReport = auditWorkerResultFn({
      worktreePath: entry.path,
      branch,
      logDir,
      mode: workerMode,
    });
    auditRecord = writeWorkerAuditFn(logDir, {
      issue: issue.identifier,
      worker: routing.worker,
      exitCode: spawnResult.exitCode,
      ...securityReport,
    });
  } catch (err) {
    securityReport = {
      ok: false,
      violations: [{ action: "security audit", reason: `audit could not complete: ${err.message}` }],
    };
  }

  if (!securityReport.ok) {
    worktreeManager.markStatus(issue.identifier, "failed");
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: "Worker safety boundary blocked publication.",
      headline: "**Worker safety boundary blocked publication.**",
      sections: [
        ...securityReport.violations.map((violation) => `- ${violation.reason}: \`${String(violation.action).slice(0, 500)}\``),
        "",
        `Audit record: \`${auditRecord?.path || logDir}\`${auditRecord?.sha256 ? ` (SHA-256 \`${auditRecord.sha256}\`)` : ""}`,
        "",
        "The issue was moved to `Needs Human Decision`; no dispatcher push, PR mutation, or staged workflow application was performed.",
      ],
    });
    return { issue: issue.identifier, outcome: "security-blocked", violations: securityReport.violations };
  }

  verificationEvidence = captureVerificationEvidenceFn(logDir);

  // A native harness can prove that a scope-only command never reached the
  // shell. Keep that fact visible, but do not let it conceal the worker's
  // actual exit condition (notably MOV-151's provider-rate-limit retry).
  if (securityReport.warnings?.length) {
    await publisher.publish("progress", {
      summary: "Worker attempted a scope-only command that the safety harness denied; continuing with the actual worker outcome.",
      headline: "**Worker scope warning; no command executed.**",
      sections: [
        ...securityReport.warnings.map((warning) => `- ${warning.reason}: \`${String(warning.action).slice(0, 500)}\``),
        "",
        "The native worker harness denied these commands before execution. They remain in the checksummed audit record, but did not grant the worker Git, GitHub, credential, or remote authority.",
      ],
    });
  }

  // MOV-299: Codex can narrate a first-tool sandbox refusal and exit 0. Run
  // this dedicated host-failure check before the ordinary nonzero-exit gate;
  // its classifier requires both the structured report and no audited tool
  // activity, so an arbitrary zero-change/zero-exit result still follows the
  // normal publication path below.
  const tail = tailLogs(logDir, 50);
  const classification = classifyWorkerFailure({
    exitCode: spawnResult.exitCode,
    logTail: tail,
    toolActions: securityReport.actions,
  });

  if (classification?.category === NESTED_SANDBOX_CRASH) {
    // MOV-180/MOV-299: this is an environment-wide fault, not a task failure
    // — every worker on this Mac hits it identically while it holds. Requeue
    // the issue for a later retry instead of leaving it looking like a real
    // per-issue failure in Needs Human Decision, and stop dispatching anything
    // else until the condition is confirmed cleared.
    const legacyNestedSandboxCrash = spawnResult.exitCode === 71;
    circuitBreaker.trip(
      NESTED_SANDBOX_CRASH,
      legacyNestedSandboxCrash
        ? `worker exited ${spawnResult.exitCode} with the nested-sandbox-crash signature`
        : `worker exited ${spawnResult.exitCode} with sandbox_apply: Operation not permitted before an executed tool action`,
    );
    worktreeManager.markStatus(issue.identifier, "failed");
    await publisher.publish("error", {
      stateId: stateIds.readyForAgent,
      summary: "Worker hit a host-wide nested-sandbox crash, not a task failure. Requeued to Ready for Agent; dispatch is paused until the Mac is fixed.",
      headline: legacyNestedSandboxCrash
        ? "**Environment failure, not a task failure: nested macOS sandbox crash (MOV-180).**"
        : "**Environment failure, not a task failure: nested macOS sandbox crash (MOV-299).**",
      sections: legacyNestedSandboxCrash
        ? [
            "This run failed before it could do any real work: the harness's own tool sandbox could not apply a second Seatbelt profile inside the one `worker-guard.mjs` already applies to the worker process (`sandbox_apply: Operation not permitted`, exit 71). Every worker on this Mac fails identically while this condition holds — it is not specific to this issue, and re-running it here will not help.",
            "",
            "This issue has been moved back to `Ready for Agent` rather than `Needs Human Decision`, and the dispatcher has stopped starting any further issue until the condition is confirmed cleared. See docs/operators/local-execution.md §Security model for the manual recovery procedure: a clean `launchctl bootout` + `launchctl bootstrap` of `com.moviecal.dispatcher` (`launchctl kickstart -k` is not sufficient).",
            "",
            "```",
            tail,
            "```",
            "",
            `Full run log: \`${logDir}\``,
          ]
        : [
            `This run failed before it could do any real work: the worker reported \`sandbox_apply: Operation not permitted\` before an executed tool action (worker exit ${spawnResult.exitCode}). Every worker on this Mac may fail identically while this condition holds — it is not specific to this issue, and re-running it here will not help.`,
            "",
            "This issue has been moved back to `Ready for Agent` rather than `Needs Human Decision`, and the dispatcher has stopped starting any further issue until the condition is confirmed cleared. See docs/operators/local-execution.md §Security model for the manual recovery procedure.",
            "",
            "```",
            tail,
            "```",
            "",
            `Full run log: \`${logDir}\``,
          ],
    });
    return { issue: issue.identifier, outcome: "nested-sandbox-crash", exitCode: spawnResult.exitCode };
  }

  if (spawnResult.exitCode !== 0) {

    // MOV-177: the dispatcher's own worker credential (`CLAUDE_CODE_OAUTH_TOKEN`
    // today) has gone bad — a 401/`authentication_failed` signature, distinct
    // from both the nested-sandbox-crash check above and the provider-usage-limit
    // check below. Like the nested-sandbox crash, this is dispatcher-wide, not
    // issue-specific: every worker fails identically until a human regenerates
    // the credential. Requeue rather than escalate, and trip the breaker so the
    // dispatcher stops burning through the rest of the Ready for Agent queue one
    // issue at a time on the same dead credential.
    const credentialFailure = classifyCredentialFailure({ exitCode: spawnResult.exitCode, logTail: tail });
    if (credentialFailure) {
      circuitBreaker.trip(
        CREDENTIAL_FAILURE,
        `worker exited ${spawnResult.exitCode} with a credential-failure signature: ${credentialFailure.evidence}`,
      );
      worktreeManager.markStatus(issue.identifier, "failed");
      await publisher.publish("error", {
        stateId: stateIds.readyForAgent,
        summary: "Dispatcher credential is invalid or expired. Automatic dispatch is paused until this is fixed.",
        headline: "**Dispatcher credential is invalid or expired.** Automatic dispatch is paused until this is fixed.",
        sections: [
          `This run failed before it could do any real work: the worker's provider credential was rejected (\`${credentialFailure.evidence}\`). This is dispatcher-wide, not specific to this issue — every worker will fail identically until the credential (\`CLAUDE_CODE_OAUTH_TOKEN\` today) is regenerated.`,
          "",
          "This issue has been moved back to `Ready for Agent` rather than `Needs Human Decision` — it did nothing wrong, the credential did. The dispatcher has stopped starting any further issue until a subsequent dispatch attempt succeeds, which is treated as confirmation the credential is healthy again. See docs/operators/local-execution.md §Security model.",
          "",
          "```",
          tail,
          "```",
          "",
          `Full run log: \`${logDir}\``,
        ],
      });
      return { issue: issue.identifier, outcome: "credential-failure", exitCode: spawnResult.exitCode };
    }

    // MOV-151: a dispatch-time provider usage/rate limit. The worker never got
    // a session, so nothing was implemented, nothing was pushed, and no PR
    // exists — the failure says something about the provider's quota clock and
    // nothing about this issue. Retry once at the reset time the provider
    // itself named; escalate on the second consecutive occurrence, on an
    // unparseable reset, and (via the null classification below) on every
    // other non-zero exit exactly as before.
    const usageLimit = classifyUsageLimitFailure({ exitCode: spawnResult.exitCode, logTail: tail, now: now() });

    // MOV-151 preserved the worktree here and stopped: a provider limit that
    // landed on top of unpublished changes went permanently to a human,
    // because requeueing would have collided with (or reclaimed) a worktree
    // holding real work. Preserving it was right; needing a human to *resume*
    // it was not — a usage limit says nothing about this issue, and MOV-190
    // hit exactly this and spent a human on it.
    //
    // MOV-205 adds the one missing move: retain the worktree exactly as
    // before, and schedule a single bounded resume *in place* at the reset.
    // Nothing is reclaimed, removed, or recreated on either branch below; the
    // only difference from MOV-151 is whether a human or the next poll cycle
    // picks the work back up.
    const unpublishedPaths = usageLimit ? uncommittedChangesFn(entry.path) : [];
    if (usageLimit && unpublishedPaths.length > 0) {
      let verdict = decideUsageLimitOutcome({
        classification: usageLimit,
        previous: usageLimitStore.get(issue.identifier),
        now: now(),
        retainedWorktree: true,
      });

      // Same durability proof the clean-worktree retry makes, and for the same
      // reason: an unrecorded resume is an unbounded one. The resume plan has
      // to land in the same transaction as the retry time, or this falls
      // through to the escalation below — which is exactly MOV-151's
      // behaviour, so an unwired or failing store degrades to it rather than
      // to a loop.
      if (verdict.action === "resume-at-reset") {
        const recorded = usageLimitStore.record(issue.identifier, {
          retryAt: verdict.retryAt,
          evidence: usageLimit.evidence,
          consecutive: verdict.consecutive,
          resume: {
            worktreePath: entry.path,
            branch,
            repository: ghRepo,
            retryAt: verdict.retryAt,
            unpublishedPaths,
          },
          now: now(),
        });
        if (recorded?.retryAt !== verdict.retryAt || recorded?.resume?.worktreePath !== entry.path) {
          verdict = {
            ...verdict,
            action: "escalate",
            reason: `worker reported a provider usage limit resetting at ${verdict.retryAt} after producing unpublished changes, but the resume of the retained worktree could not be recorded durably, so a single bounded resume cannot be guaranteed`,
            retryAt: null,
          };
        }
      }

      if (verdict.action === "resume-at-reset") {
        // The registry's own half of the durable record. `usageLimitResumeAt`
        // is re-checked against the store's plan at re-admission, so the two
        // records have to agree for the resume to be allowed to start.
        worktreeManager.markStatus(issue.identifier, "failed", {
          usageLimitResumeAt: verdict.retryAt,
          retainedForResume: true,
        });
        await publisher.publish("progress", {
          stateId: stateIds.readyForAgent,
          action: "Deferred until the provider usage limit resets; the retained worktree will be resumed in place",
          summary: `Provider usage limit reached after unpublished work was produced. The worktree is retained and will be resumed in place at ${verdict.retryAt}.`,
          headline: "**Provider usage limit after unpublished work; the retained worktree will be resumed in place (MOV-205).**",
          sections: [
            `The ${routing.worker} worker exited ${spawnResult.exitCode} reporting a provider usage/session limit, having already produced unpublished changes. Nothing was published and no PR exists, so nothing about this issue is known to be wrong.`,
            "",
            `Reported limit: \`${usageLimit.evidence}\``,
            `Scheduled resume: **${verdict.retryAt}** (parsed from the provider's own message, precision \`${usageLimit.precision}\`).`,
            "",
            `Retained worktree: \`${entry.path}\` on \`${branch}\`. It is **not** reclaimed, removed, or replaced — the resumed worker runs in this same worktree and continues from this same partial implementation.`,
            "",
            "Unpublished paths:",
            "```",
            ...unpublishedPaths,
            "```",
            "",
            "Before that resumed worker starts, the dispatcher re-validates its own ownership of the worktree, the worktree's integrity and checked-out branch, the branch and repository identity, and the registry provenance — and runs it behind the same safety boundary as any other worker. Exactly one resume is scheduled: a second consecutive provider limit, a failed re-validation, or any non-limit failure escalates to `Needs Human Decision` instead.",
            "",
            "```",
            tail,
            "```",
            "",
            `Full run log: \`${logDir}\``,
          ],
        });
        return {
          issue: issue.identifier,
          outcome: "usage-limit-resume-deferred",
          exitCode: spawnResult.exitCode,
          retryAt: verdict.retryAt,
          worktreePath: entry.path,
          uncommittedPaths: unpublishedPaths,
        };
      }

      // Bounded: a second consecutive provider limit, a missing/unparseable or
      // too-distant reset, or a resume that could not be recorded durably all
      // land here. The worktree is retained untouched exactly as MOV-151 left
      // it, and the count stays truthful rather than being cleared, so a human
      // reading the record can see this was the second limit and not the first.
      usageLimitStore.record(issue.identifier, {
        retryAt: null,
        evidence: usageLimit.evidence,
        consecutive: verdict.consecutive,
        now: now(),
      });
      worktreeManager.markStatus(issue.identifier, "failed");
      await publisher.publish("error", {
        stateId: stateIds.needsHumanDecision,
        summary: `Worker reported a provider usage limit after producing unpublished changes, and it cannot be resumed automatically: ${verdict.reason}`,
        headline: "**Provider usage limit followed unpublished work, and no automatic resume is available; human review required.**",
        sections: [
          `Reason: ${verdict.reason}`,
          "",
          `Retained worktree: \`${entry.path}\` on \`${branch}\`. The dispatcher will not requeue, reclaim, or remove it automatically — recover or discard the unpublished work by hand.`,
          "",
          "Unpublished paths:",
          "```",
          ...unpublishedPaths,
          "```",
          "",
          "```",
          tail,
          "```",
          "",
          `Full run log: \`${logDir}\``,
        ],
      });
      return {
        issue: issue.identifier,
        outcome: "worker-failed",
        exitCode: spawnResult.exitCode,
        usageLimit: verdict.reason,
        uncommittedPaths: unpublishedPaths,
      };
    }

    let usageVerdict = decideUsageLimitOutcome({
      classification: usageLimit,
      previous: usageLimitStore.get(issue.identifier),
      now: now(),
    });

    // Requeueing to `Ready for Agent` is only bounded if the deferral and the
    // consecutive counter actually persist — without them the next poll cycle
    // immediately re-dispatches, hits the same limit, and requeues again,
    // forever. So the retry is conditional on the store proving it kept the
    // record, which also covers an unwired caller (the no-op default store)
    // and a write that silently failed. When it cannot be proved, this falls
    // through to the escalation below, which is today's behaviour.
    if (usageVerdict.action === "retry-at-reset") {
      const recorded = usageLimitStore.record(issue.identifier, {
        retryAt: usageVerdict.retryAt,
        evidence: usageLimit.evidence,
        consecutive: usageVerdict.consecutive,
        now: now(),
      });
      if (recorded?.retryAt !== usageVerdict.retryAt) {
        usageVerdict = {
          ...usageVerdict,
          action: "escalate",
          reason: `worker reported a provider usage limit resetting at ${usageVerdict.retryAt}, but the retry could not be recorded durably, so a single bounded retry cannot be guaranteed`,
          retryAt: null,
        };
      }
    }

    if (usageVerdict.action === "retry-at-reset") {
      worktreeManager.markStatus(issue.identifier, "failed", { usageLimitRetryAt: usageVerdict.retryAt });
      await publisher.publish("progress", {
        stateId: stateIds.readyForAgent,
        action: "Deferred until the provider usage limit resets",
        summary: `Provider usage limit reached before any work was published. Requeued to Ready for Agent; dispatch of this issue is held until ${usageVerdict.retryAt}.`,
        headline: "**Provider usage limit, not a task failure (MOV-151).**",
        sections: [
          `The ${routing.worker} worker exited ${spawnResult.exitCode} without starting work, reporting a provider usage/session limit. No branch was published and no PR exists, so nothing about this issue is known to be wrong.`,
          "",
          `Reported limit: \`${usageLimit.evidence}\``,
          `Scheduled retry: **${usageVerdict.retryAt}** (parsed from the provider's own message, precision \`${usageLimit.precision}\`).`,
          "",
          "This issue was moved back to `Ready for Agent` rather than `Needs Human Decision`, and the dispatcher will not claim it again until that time. Exactly one retry is scheduled: a second consecutive usage-limit failure escalates to `Needs Human Decision` instead.",
          "",
          "```",
          tail,
          "```",
          "",
          `Full run log: \`${logDir}\``,
        ],
      });
      return {
        issue: issue.identifier,
        outcome: "usage-limit-deferred",
        exitCode: spawnResult.exitCode,
        retryAt: usageVerdict.retryAt,
      };
    }

    // Everything below escalates. Record a repeated usage-limit failure so the
    // count stays truthful; clear the record for any other kind of failure,
    // since the escalation rule is about *consecutive* usage-limit failures.
    if (usageLimit) {
      usageLimitStore.record(issue.identifier, {
        retryAt: null,
        evidence: usageLimit.evidence,
        consecutive: usageVerdict.consecutive,
        now: now(),
      });
    } else {
      usageLimitStore.clear(issue.identifier);
    }

    worktreeManager.markStatus(issue.identifier, "failed");
    // MOV-179: this is exactly the residual "unrecognized failure" bucket —
    // every dedicated classification above (nested-sandbox-crash, credential
    // failure, security-policy block, provider usage limit) already returned
    // with its own grounded comment, so a usage-limit reason already exists
    // and needs no advisory diagnosis on top of it.
    const diagnosis = usageLimit
      ? []
      : await diagnosisSections(diagnoseFailureFn, {
          exitCode: spawnResult.exitCode,
          logTail: tail,
          auditText: JSON.stringify(securityReport ?? {}),
        });
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: usageLimit
        ? `Worker exited with code ${spawnResult.exitCode} on a provider usage limit that cannot be retried automatically: ${usageVerdict.reason}`
        : `Worker exited with code ${spawnResult.exitCode}.`,
      headline: usageLimit
        ? `**Worker exited with code ${spawnResult.exitCode} on a provider usage limit that cannot be retried automatically.**`
        : `**Worker exited with code ${spawnResult.exitCode}.**`,
      sections: [
        ...(usageLimit ? [`Reason: ${usageVerdict.reason}`, ""] : []),
        ...diagnosis,
        "```",
        tail,
        "```",
        "",
        `Full run log: \`${logDir}\``,
      ],
    });
    return {
      issue: issue.identifier,
      outcome: "worker-failed",
      exitCode: spawnResult.exitCode,
      ...(usageLimit ? { usageLimit: usageVerdict.reason } : {}),
    };
  }

  // MOV-180/MOV-177: a worker reaching this point ran to completion — proof
  // that neither host-wide condition either breaker guards against (a nested
  // sandbox crash, an invalid/expired dispatcher credential) is still
  // happening, since either one would have short-circuited above before a
  // clean exit was possible. Clearing an already-closed breaker is a no-op
  // (see circuit-breaker.mjs), so this is safe to run unconditionally.
  for (const name of DISPATCH_BREAKERS) circuitBreaker.clear(name);
  // MOV-151: and the provider granted this issue a session that ran to a
  // clean exit, so whatever usage-limit history it had is no longer
  // "consecutive". Nothing to forget in the overwhelmingly common case.
  usageLimitStore.clear(issue.identifier);

  const workflowAuth = resolveWorkflowEditAuthorization(issue);
  if (workflowAuth.authorized && workerMode !== "repair") {
    // MOV-158, `before-workflow-edit` boundary: applying a staged proposal
    // commits and pushes on the worker's behalf, so a pending stop has to be
    // honoured before it, not after.
    if (stopController.checkpoint("before-workflow-edit").halt) {
      return reportStop(stopController.stopRequest, { issue, publisher, worktreeManager });
    }
    const applyResult = applyStagedWorkflowEditFn(entry.path, workflowAuth.path);
    if (applyResult.applied) {
      await publisher.publish("progress", {
        action: "Applied staged workflow-edit proposal",
        summary: `Applied staged workflow-edit proposal: ${workflowAuth.path}`,
        headline: `**Applied staged workflow-edit proposal:** \`${workflowAuth.path}\`. Written by the worker to \`tools/dispatcher/pending-workflow-edits/\`; applied by the dispatcher itself and included in its trusted commit — see docs/operators/local-execution.md §Security model (MOV-121). The PR (once opened) will still visibly contain this diff and \`lane-review\` will flag it as requiring explicit sign-off before merge.`,
      });
    }
    // A staged file simply not existing is normal (the worker may have decided
    // not to touch the workflow after all) — not an error, no comment needed.
  }

  let pr;
  try {
    if (typeof publishWorkerResultFn !== "function") {
      throw new Error("trusted dispatcher publisher is not configured");
    }
    pr = publishWorkerResultFn({ worktreePath: entry.path, branch, repo: ghRepo, issue, verificationEvidence });
  } catch (err) {
    worktreeManager.markStatus(issue.identifier, "failed");
    // MOV-179: also the unrecognized-failure bucket — a publish refusal has
    // no dedicated classification of its own, so it gets the same advisory
    // diagnosis treatment as a generic worker exit above.
    const diagnosis = await diagnosisSections(diagnoseFailureFn, {
      exitCode: spawnResult.exitCode,
      logTail: tailLogs(logDir, 50),
      auditText: err.message,
    });
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: `Dispatcher refused or failed to publish the audited worker result: ${err.message}`,
      headline: `**Dispatcher refused or failed to publish the audited worker result:** ${err.message}`,
      sections: [...diagnosis, `Audit record: \`${auditRecord?.path || logDir}\``],
    });
    return { issue: issue.identifier, outcome: "publish-failed", error: err.message };
  }
  if (!pr) {
    worktreeManager.markStatus(issue.identifier, "failed");

    const uncommittedPaths = uncommittedChangesFn(entry.path);
    if (uncommittedPaths.length > 0) {
      await publisher.publish("error", {
        stateId: stateIds.needsHumanDecision,
        summary: `Dispatcher found unpublished changes after the trusted publication step for branch ${branch}.`,
        headline: `**Dispatcher found unpublished changes after the trusted publication step for branch \`${branch}\`.** Publication failed closed; inspect the retained worktree and audit before retrying.`,
        sections: [
          "Uncommitted paths:",
          "```",
          uncommittedPaths.join("\n"),
          "```",
          "",
          "Last ~30 log lines:",
          "```",
          tailLogs(logDir, 30),
          "```",
          "",
          `Full run log: \`${logDir}\``,
        ],
      });
      return { issue: issue.identifier, outcome: "abandoned-dirty", uncommittedPaths };
    }

    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: `Worker exited 0 but the trusted dispatcher found no PR for branch ${branch}.`,
      headline: `**Worker exited 0 but the trusted dispatcher found no PR for branch \`${branch}\`.** Run log: \`${logDir}\``,
    });
    return { issue: issue.identifier, outcome: "no-pr" };
  }

  // MOV-158, `before-pr-report` boundary: the PR itself exists on GitHub and a
  // stop does not withdraw it — but the `In Review` transition and the PR-link
  // publication are writes, and a stopped attempt makes none.
  if (stopController.checkpoint("before-pr-report").halt) {
    return reportStop(stopController.stopRequest, { issue, publisher, worktreeManager });
  }

  worktreeManager.markStatus(issue.identifier, "review", {
    prNumber: pr.number,
    prUrl: pr.url,
    headSha: pr.headSha || null,
  });
  publisher.setContext({ prUrl: pr.url });
  await publisher.publish("pr-opened", {
    stateId: stateIds.inReview,
    summary: `Pull request opened: ${pr.url}${pr.isDraft ? " (draft)" : ""}`,
    headline: `**Pull request opened:** ${pr.url}${pr.isDraft ? " (draft)" : ""}`,
  });
  return { issue: issue.identifier, outcome: "in-review", pr: pr.url };
}
