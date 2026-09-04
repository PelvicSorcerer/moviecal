// The dispatcher's core orchestration: given a batch of Linear issues in
// "Ready for Agent", run each through preflight, provision a worktree, spawn
// a worker, and report the outcome back to Linear.
//
// This module takes every dependency as an explicit parameter (no direct
// `fetch`/`child_process`/filesystem calls of its own) so the orchestration
// logic — which is the part worth getting right — is fully unit-testable
// with fakes. See bin/dispatcher.mjs for how real dependencies are wired up.

import path from "node:path";
import { evaluatePreflight, worktreeName, branchName } from "./preflight.mjs";
import { resolveRouting, workerInvocation } from "./worker-routing.mjs";
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
 * @param {(args: object) => Promise<{exitCode: number, logDir: string}>} ctx.spawnWorkerFn
 * @param {(branch: string, repo: string) => {number:number,url:string,isDraft:boolean}|null} ctx.findPrForBranchFn
 * @returns {Promise<Array<{issue: string, outcome: string, [key: string]: unknown}>>}
 */
export async function runOnce(issues, ctx) {
  const results = [];
  for (const issue of issues) {
    results.push(await processIssue(issue, ctx));
  }
  return results;
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
  } = ctx;

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

  let spawnResult;
  try {
    spawnResult = await spawnWorkerFn({ invocation, cwd: entry.path, brief, logDir });
  } catch (err) {
    worktreeManager.markStatus(issue.identifier, "failed");
    await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
    await linearClient.addComment(
      issue.id,
      `**Dispatcher failed to start the worker:** ${err.message}\n\nRun log: \`${logDir}\``,
    );
    return { issue: issue.identifier, outcome: "spawn-error", error: err.message };
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

  const pr = findPrForBranchFn(branch, ghRepo);
  if (!pr) {
    worktreeManager.markStatus(issue.identifier, "failed");
    await linearClient.moveToState(issue.id, stateIds.needsHumanDecision);
    await linearClient.addComment(
      issue.id,
      `**Worker exited 0 but no PR was found for branch \`${branch}\`.** The worker is responsible for opening its own PR (see docs/operators/local-execution.md). Run log: \`${logDir}\``,
    );
    return { issue: issue.identifier, outcome: "no-pr" };
  }

  worktreeManager.markStatus(issue.identifier, "review");
  await linearClient.moveToState(issue.id, stateIds.inReview);
  await linearClient.addComment(issue.id, `**Pull request opened:** ${pr.url}${pr.isDraft ? " (draft)" : ""}`);
  return { issue: issue.identifier, outcome: "in-review", pr: pr.url };
}
