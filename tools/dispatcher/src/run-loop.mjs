// The dispatcher's core orchestration: given a batch of Linear issues in
// "Ready for Agent", run each through preflight, provision a worktree, spawn
// a worker, and report the outcome back to Linear.
//
// This module takes every dependency as an explicit parameter (no direct
// `fetch`/`child_process`/filesystem calls of its own) so the orchestration
// logic — which is the part worth getting right — is fully unit-testable
// with fakes. See bin/dispatcher.mjs for how real dependencies are wired up.

import path from "node:path";
import { evaluatePreflight, worktreeName, branchName, resolveWorkflowEditAuthorization } from "./preflight.mjs";
import { resolveRouting, workerInvocation } from "./worker-routing.mjs";
import { confirmStillClaimable, evaluateLocalDispatch } from "./dispatch-eligibility.mjs";
import { generateBrief } from "./brief.mjs";
import { tailLogs } from "./worker-spawn.mjs";
import { LifecyclePublisher } from "./agent-lifecycle.mjs";
import { nullAgentSessionBridge } from "./agent-session.mjs";
import { StopController, detectStopFromSnapshot, watchForStop } from "./agent-signals.mjs";

/**
 * @param {object[]} issues - from LinearClient.issuesInState()
 * @param {object} ctx
 * @param {object} ctx.linearClient - LinearClient instance (or a fake with the same shape)
 * @param {Record<string,string>} ctx.stateIds - {blocked, agentWorking, needsHumanDecision, inReview}, from LinearClient.workflowStates()
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
 * @param {(branch: string, repo: string) => {number:number,url:string,isDraft:boolean}|null} ctx.findPrForBranchFn
 * @param {number} ctx.workerTimeoutMs - MOV-138: a worker that hasn't exited after this many ms is killed and its issue moved to Needs Human Decision
 * @param {(worktreePath: string) => string[]} [ctx.uncommittedChangesFn] - MOV-137; defaults to "always clean" if not provided (tests that don't care about this can omit it)
 * @param {(worktreePath: string, authorizedPath: string) => {applied: boolean, path?: string, reason?: string}} [ctx.applyStagedWorkflowEditFn] - MOV-121; defaults to a no-op if not provided (tests that don't care about this can omit it)
 * @param {{id?: string|null, name?: string|null}} [ctx.dispatcherDelegate] - MOV-143: the delegate an issue must name for this dispatcher to claim it; defaults to matching `moviecal-dispatcher` by name
 * @param {(issue: object) => Promise<object|null>} [ctx.refreshIssueFn] - MOV-143: re-read an issue immediately before committing to it, so a route/delegation change since the poll snapshot is a safe no-op; defaults to reusing the snapshot (tests that don't exercise the race can omit it)
 * @param {() => object} [ctx.agentSessionBridgeFn] - MOV-158: build the (feature-gated) Agent Session bridge for one attempt; defaults to a permanently-disabled bridge, so lifecycle events publish as app-actor comments exactly as they did before
 * @param {(issueIdentifier: string) => object|null} [ctx.readAgentSessionFn] - MOV-158: the prior attempt's persisted session record, used to decide attach-vs-new-linked-session; defaults to "no prior session"
 * @param {(issueIdentifier: string, snapshot: object) => void} [ctx.persistAgentSessionFn] - MOV-158: persist this attempt's session record for the next one; defaults to a no-op
 * @param {number} [ctx.stopPollIntervalMs] - MOV-158: how often to re-read the issue while a worker runs, so a de-delegation/cancellation is honoured at the next safe boundary instead of after a 45-minute worker; 0 (the default) disables the watcher entirely
 * @returns {Promise<Array<{issue: string, outcome: string, [key: string]: unknown}>>}
 */
export async function runOnce(issues, ctx) {
  const { concurrencyLimit, worktreeManager } = ctx;

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
      await acquire();
      try {
        results[index] = await processIssue(issue, ctx);
      } finally {
        release();
      }
    }),
  );
  return results;
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

async function processIssue(issue, ctx) {
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
    findPrForBranchFn,
    workerTimeoutMs,
    uncommittedChangesFn = () => [],
    applyStagedWorkflowEditFn = () => ({ applied: false, reason: "not configured" }),
    dispatcherDelegate = {},
    refreshIssueFn = async (snapshot) => snapshot,
    agentSessionBridgeFn = () => nullAgentSessionBridge(),
    readAgentSessionFn = () => null,
    persistAgentSessionFn = () => {},
    stopPollIntervalMs = 0,
    logger = console,
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

  const name = worktreeName(issue.identifier, issue.title);
  const branch = branchName(issue.identifier, issue.title);
  const candidatePath = path.join(worktreeRoot, name);

  const preflight = evaluatePreflight(issue, {
    isIssueSatisfied,
    iosRunnerOnline,
    activeWorktreeCount: worktreeManager.activeCount(),
    concurrencyLimit,
    secretPresent,
    worktreePathFree: (p) => worktreeManager.isPathFree(p),
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

  const entry = worktreeManager.create({
    id: issue.identifier,
    name,
    branch,
    worker: routing.worker,
    model: routing.model,
    linearUrl: issue.url,
    linearIssueId: issue.id,
    envLocalSource,
  });

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

  try {
    return await runClaimedAttempt({
      issue,
      entry,
      branch,
      routing,
      publisher,
      stopController,
      ctx: {
        stateIds,
        worktreeManager,
        ghRepo,
        logRoot,
        spawnWorkerFn,
        findPrForBranchFn,
        workerTimeoutMs,
        uncommittedChangesFn,
        applyStagedWorkflowEditFn,
        dispatcherDelegate,
        refreshIssueFn,
        stopPollIntervalMs,
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
 */
async function runClaimedAttempt({ issue, entry, branch, routing, publisher, stopController, ctx }) {
  const {
    stateIds,
    worktreeManager,
    ghRepo,
    logRoot,
    spawnWorkerFn,
    findPrForBranchFn,
    workerTimeoutMs,
    uncommittedChangesFn,
    applyStagedWorkflowEditFn,
    dispatcherDelegate,
    refreshIssueFn,
    stopPollIntervalMs,
    logger,
  } = ctx;

  await publisher.publish("acknowledged", {
    stateId: stateIds.agentWorking,
    summary: `Dispatcher picked up ${issue.identifier} on the local Mac adapter.`,
    headline: "**Dispatcher started work.**",
    sections: [
      `Worktree: \`${entry.path}\``,
      `Branch: \`${branch}\``,
      `Worker: ${routing.worker} (model: ${routing.model})`,
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

  const brief = generateBrief(issue, {
    branch,
    worktreePath: entry.path,
    worker: routing.worker,
    model: routing.model,
    upgradeConditions: routing.upgradeConditions,
  });
  const invocation = workerInvocation(routing.worker, routing.model);
  const logDir = path.join(logRoot, entry.name);

  // Two abort controllers with different jobs: `abortController` kills the
  // worker's process group (MOV-137/138), `watcherAbort` retires the stop
  // watcher once the worker has settled so no timer outlives the attempt.
  const abortController = new AbortController();
  const watcherAbort = new AbortController();
  let spawnResult;
  try {
    const workerPromise = spawnWorkerFn({ invocation, cwd: entry.path, brief, logDir, signal: abortController.signal });
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
    worktreeManager.markStatus(issue.identifier, "failed");
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: `Dispatcher failed to start the worker: ${err.message}`,
      headline: `**Dispatcher failed to start the worker:** ${err.message}`,
      sections: [`Run log: \`${logDir}\``],
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
    worktreeManager.markStatus(issue.identifier, "failed");
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: `Worker timed out after ${workerTimeoutMs}ms and was killed.`,
      headline: `**Worker timed out after ${workerTimeoutMs}ms and was killed.**`,
      sections: ["```", tailLogs(logDir, 30), "```", "", `Full run log: \`${logDir}\``],
    });
    return { issue: issue.identifier, outcome: "timeout", timeoutMs: workerTimeoutMs };
  }

  if (spawnResult.pid) worktreeManager.setWorkerPid(issue.identifier, spawnResult.pid);

  // MOV-158, `after-worker` boundary: the worker has exited and nothing has
  // been reported yet, so honouring a stop here costs no completed work.
  if (stopController.checkpoint("after-worker").halt) {
    return reportStop(stopController.stopRequest, { issue, publisher, worktreeManager });
  }

  if (spawnResult.exitCode !== 0) {
    worktreeManager.markStatus(issue.identifier, "failed");
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: `Worker exited with code ${spawnResult.exitCode}.`,
      headline: `**Worker exited with code ${spawnResult.exitCode}.**`,
      sections: ["```", tailLogs(logDir, 50), "```", "", `Full run log: \`${logDir}\``],
    });
    return { issue: issue.identifier, outcome: "worker-failed", exitCode: spawnResult.exitCode };
  }

  const workflowAuth = resolveWorkflowEditAuthorization(issue);
  if (workflowAuth.authorized) {
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
        headline: `**Applied staged workflow-edit proposal:** \`${workflowAuth.path}\`. Written by the worker to \`tools/dispatcher/pending-workflow-edits/\`; applied and committed by the dispatcher itself, not the worker — see docs/operators/local-execution.md §Security model (MOV-121). The PR (once opened) will still visibly contain this diff and \`lane-review\` will flag it as requiring explicit sign-off before merge.`,
      });
    }
    // A staged file simply not existing is normal (the worker may have decided
    // not to touch the workflow after all) — not an error, no comment needed.
  }

  const pr = findPrForBranchFn(branch, ghRepo);
  if (!pr) {
    worktreeManager.markStatus(issue.identifier, "failed");

    const uncommittedPaths = uncommittedChangesFn(entry.path);
    if (uncommittedPaths.length > 0) {
      await publisher.publish("error", {
        stateId: stateIds.needsHumanDecision,
        summary: `Worker exited 0 with uncommitted changes and no PR for branch ${branch}.`,
        headline: `**Worker exited 0 with uncommitted changes and no PR for branch \`${branch}\`.** The worktree was left dirty instead of committed and pushed — likely abandoned mid-task (e.g. backgrounded a build/test and exited instead of waiting on it).`,
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
      summary: `Worker exited 0 but no PR was found for branch ${branch}.`,
      headline: `**Worker exited 0 but no PR was found for branch \`${branch}\`.** The worker is responsible for opening its own PR (see docs/operators/local-execution.md). Run log: \`${logDir}\``,
    });
    return { issue: issue.identifier, outcome: "no-pr" };
  }

  // MOV-158, `before-pr-report` boundary: the PR itself exists on GitHub and a
  // stop does not withdraw it — but the `In Review` transition and the PR-link
  // publication are writes, and a stopped attempt makes none.
  if (stopController.checkpoint("before-pr-report").halt) {
    return reportStop(stopController.stopRequest, { issue, publisher, worktreeManager });
  }

  worktreeManager.markStatus(issue.identifier, "review", { prNumber: pr.number, prUrl: pr.url });
  publisher.setContext({ prUrl: pr.url });
  await publisher.publish("pr-opened", {
    stateId: stateIds.inReview,
    summary: `Pull request opened: ${pr.url}${pr.isDraft ? " (draft)" : ""}`,
    headline: `**Pull request opened:** ${pr.url}${pr.isDraft ? " (draft)" : ""}`,
  });
  return { issue: issue.identifier, outcome: "in-review", pr: pr.url };
}
