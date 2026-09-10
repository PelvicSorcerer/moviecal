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
  const stillClaimable = confirmStillClaimable(fresh, { expectedDelegate: dispatcherDelegate });
  if (!stillClaimable.claimable) {
    return { issue: issue.identifier, outcome: "not-eligible", reason: stillClaimable.reason };
  }

  const entry = worktreeManager.create({
    id: issue.identifier,
    name,
    branch,
    worker: routing.worker,
    model: routing.model,
    linearUrl: issue.url,
    envLocalSource,
  });

  await linearClient.moveToState(issue.id, stateIds.agentWorking);
  await linearClient.addComment(
    issue.id,
    [
      "**Dispatcher started work.**",
      "",
      `Worktree: \`${entry.path}\``,
      `Branch: \`${branch}\``,
      `Worker: ${routing.worker} (model: ${routing.model})`,
    ].join("\n"),
  );

  const brief = generateBrief(issue, {
    branch,
    worktreePath: entry.path,
    worker: routing.worker,
    model: routing.model,
    upgradeConditions: routing.upgradeConditions,
  });
  const invocation = workerInvocation(routing.worker, routing.model);
  const logDir = path.join(logRoot, name);

  const abortController = new AbortController();
  let spawnResult;
  try {
    spawnResult = await raceWorkerTimeout(
      spawnWorkerFn({ invocation, cwd: entry.path, brief, logDir, signal: abortController.signal }),
      workerTimeoutMs,
    );
  } catch (err) {
    worktreeManager.markStatus(issue.identifier, "failed");
    await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
    await linearClient.addComment(
      issue.id,
      `**Dispatcher failed to start the worker:** ${err.message}\n\nRun log: \`${logDir}\``,
    );
    return { issue: issue.identifier, outcome: "spawn-error", error: err.message };
  }

  if (spawnResult === WORKER_TIMEOUT) {
    // MOV-138: kill the worker's process group (reuses MOV-137's group-kill
    // in worker-spawn.mjs, triggered by the abort signal) and hand off to a
    // human rather than let a hang (MOV-106) freeze the rest of the batch.
    abortController.abort();
    worktreeManager.markStatus(issue.identifier, "failed");
    await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
    await linearClient.addComment(
      issue.id,
      [
        `**Worker timed out after ${workerTimeoutMs}ms and was killed.**`,
        "",
        "```",
        tailLogs(logDir, 30),
        "```",
        "",
        `Full run log: \`${logDir}\``,
      ].join("\n"),
    );
    return { issue: issue.identifier, outcome: "timeout", timeoutMs: workerTimeoutMs };
  }

  if (spawnResult.exitCode !== 0) {
    worktreeManager.markStatus(issue.identifier, "failed");
    await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
    await linearClient.addComment(
      issue.id,
      [
        `**Worker exited with code ${spawnResult.exitCode}.**`,
        "",
        "```",
        tailLogs(logDir, 50),
        "```",
        "",
        `Full run log: \`${logDir}\``,
      ].join("\n"),
    );
    return { issue: issue.identifier, outcome: "worker-failed", exitCode: spawnResult.exitCode };
  }

  const workflowAuth = resolveWorkflowEditAuthorization(issue);
  if (workflowAuth.authorized) {
    const applyResult = applyStagedWorkflowEditFn(entry.path, workflowAuth.path);
    if (applyResult.applied) {
      await linearClient.addComment(
        issue.id,
        `**Applied staged workflow-edit proposal:** \`${workflowAuth.path}\`. Written by the worker to \`tools/dispatcher/pending-workflow-edits/\`; applied and committed by the dispatcher itself, not the worker — see docs/operators/local-execution.md §Security model (MOV-121). The PR (once opened) will still visibly contain this diff and \`lane-review\` will flag it as requiring explicit sign-off before merge.`,
      );
    }
    // A staged file simply not existing is normal (the worker may have decided
    // not to touch the workflow after all) — not an error, no comment needed.
  }

  const pr = findPrForBranchFn(branch, ghRepo);
  if (!pr) {
    worktreeManager.markStatus(issue.identifier, "failed");
    await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);

    const uncommittedPaths = uncommittedChangesFn(entry.path);
    if (uncommittedPaths.length > 0) {
      await linearClient.addComment(
        issue.id,
        [
          `**Worker exited 0 with uncommitted changes and no PR for branch \`${branch}\`.** The worktree was left dirty instead of committed and pushed — likely abandoned mid-task (e.g. backgrounded a build/test and exited instead of waiting on it).`,
          "",
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
        ].join("\n"),
      );
      return { issue: issue.identifier, outcome: "abandoned-dirty", uncommittedPaths };
    }

    await linearClient.addComment(
      issue.id,
      `**Worker exited 0 but no PR was found for branch \`${branch}\`.** The worker is responsible for opening its own PR (see docs/operators/local-execution.md). Run log: \`${logDir}\``,
    );
    return { issue: issue.identifier, outcome: "no-pr" };
  }

  worktreeManager.markStatus(issue.identifier, "review", { prNumber: pr.number, prUrl: pr.url });
  await linearClient.moveToState(issue.id, stateIds.inReview);
  await linearClient.addComment(issue.id, `**Pull request opened:** ${pr.url}${pr.isDraft ? " (draft)" : ""}`);
  return { issue: issue.identifier, outcome: "in-review", pr: pr.url };
}
