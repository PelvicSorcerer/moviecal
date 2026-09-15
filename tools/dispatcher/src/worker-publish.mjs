// Privileged publication boundary for dispatcher workers (MOV-145).
//
// Workers produce filesystem changes but receive no Git or GitHub mutation
// authority. Only this trusted dispatcher-side function stages and commits the
// audited changes, pushes the exact assigned branch (never with force), and
// creates the draft PR after worker-guard validation.

import { execFileSync } from "node:child_process";
import { findPrForBranch } from "./pr-check.mjs";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

export function pullRequestBody(issue) {
  return [
    "## Summary",
    "",
    `Implements ${issue.identifier}: ${issue.title}`,
    "",
    "## Test Impact",
    "",
    "- The worker was required to add or update the automated coverage in the Linear issue's Testing Expectations and run `npm run verify` before handoff.",
    "- GitHub CI remains authoritative for the recorded lane results.",
    "",
    "## Manual testing",
    "",
    "- Complete the Manual Testing Checklist on the pushed branch before promoting this draft PR.",
    "",
    `Linear: ${issue.identifier}`,
    "",
    `Fixes ${issue.identifier}`,
  ].join("\n");
}

/**
 * Commit, push, and find/create one draft PR. Every argument is passed through
 * execFileSync (no shell), branch identity is checked again immediately
 * before the push, and a non-fast-forward remote rejects naturally.
 */
export function publishWorkerResult({ worktreePath, branch, repo, issue, runner = defaultRunner } = {}) {
  if (!branch?.startsWith(`agent/${issue?.identifier}-`)) {
    throw new Error("assigned branch does not match the dispatcher issue namespace");
  }
  const actualBranch = String(runner("git", ["branch", "--show-current"], { cwd: worktreePath })).trim();
  if (actualBranch !== branch) throw new Error(`refusing to publish ${actualBranch || "detached HEAD"}; expected ${branch}`);

  const dirty = String(runner("git", ["status", "--porcelain=v1"], { cwd: worktreePath })).trim();
  if (!dirty) throw new Error("worker produced no audited filesystem changes");
  runner("git", ["add", "--all"], { cwd: worktreePath });
  const staged = String(runner("git", ["diff", "--cached", "--name-only"], { cwd: worktreePath })).trim();
  if (!staged) throw new Error("worker changes produced an empty Git index");
  runner("git", ["commit", "-m", `fix: ${issue.identifier} ${issue.title}`], { cwd: worktreePath });

  const afterCommit = String(runner("git", ["status", "--porcelain=v1"], { cwd: worktreePath })).trim();
  if (afterCommit) throw new Error("dispatcher commit did not leave a clean worktree");
  const ahead = Number(String(runner("git", ["rev-list", "--count", "origin/master..HEAD"], { cwd: worktreePath })).trim());
  if (!Number.isInteger(ahead) || ahead < 1) throw new Error("dispatcher produced no commit ahead of origin/master");

  runner("git", ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], { cwd: worktreePath });
  let pr = findPrForBranch(branch, repo, runner);
  if (!pr) {
    runner("gh", [
      "pr",
      "create",
      "--draft",
      "--repo",
      repo,
      "--base",
      "master",
      "--head",
      branch,
      "--title",
      `${issue.identifier}: ${issue.title}`,
      "--body",
      pullRequestBody(issue),
    ], { cwd: worktreePath });
    pr = findPrForBranch(branch, repo, runner);
  }
  if (!pr) throw new Error(`GitHub did not return a PR for ${branch} after creation`);
  return pr;
}

/**
 * Re-run the failed jobs of every workflow run attached to one head SHA
 * (MOV-151).
 *
 * This is the whole of the "recognized infrastructure failure" response, and
 * the point is what it does *not* do: no worker starts, no file is touched,
 * no commit is made. A flaky runner, a 503 from a registry, or a cancelled
 * job is not evidence that the code is wrong, and the one thing automation
 * must never do with a transient failure is invent a code change to explain
 * it.
 *
 * Scoped to the head SHA so an older run from a superseded push is never
 * restarted, and `rerun-failed-jobs` (rather than a whole-run rerun) so
 * already-green jobs are not re-spent.
 */
export function rerunFailedChecks({ repo, headSha, runner = defaultRunner } = {}) {
  if (!repo || !headSha) throw new Error("rerunFailedChecks requires repo and headSha");
  const payload = JSON.parse(
    runner("gh", ["api", `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`]),
  );
  const failed = (payload.workflow_runs || []).filter((run) =>
    ["failure", "cancelled", "canceled", "timed_out", "startup_failure"].includes(
      String(run.conclusion || "").toLowerCase(),
    ),
  );
  if (!failed.length) throw new Error(`no failed workflow run is attached to ${headSha}`);
  const reran = [];
  for (const run of failed) {
    runner("gh", ["api", "-X", "POST", `repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`]);
    reran.push({ id: run.id, name: run.name || run.display_title || null });
  }
  return { headSha, reran };
}

/**
 * Publish an audited repair onto an existing dispatcher-owned PR.
 *
 * Unlike the implementation publisher this never creates a branch or PR. The
 * observed head SHA is an optimistic-concurrency boundary: if GitHub (or a
 * human) advanced the checkout after the repair decision, publication stops
 * before staging anything. The ordinary non-force push provides the matching
 * remote-side check if the branch advances after this local comparison.
 */
export function publishRepairResult({ worktreePath, branch, repo, issue, expectedHeadSha, runner = defaultRunner } = {}) {
  if (!branch?.startsWith(`agent/${issue?.identifier}-`)) {
    throw new Error("assigned branch does not match the dispatcher issue namespace");
  }
  if (!expectedHeadSha) throw new Error("repair publication requires the observed head SHA");

  const actualBranch = String(runner("git", ["branch", "--show-current"], { cwd: worktreePath })).trim();
  if (actualBranch !== branch) throw new Error(`refusing to publish ${actualBranch || "detached HEAD"}; expected ${branch}`);
  const actualHeadSha = String(runner("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).trim();
  if (actualHeadSha !== expectedHeadSha) {
    throw new Error(`repair target moved from observed SHA ${expectedHeadSha} to ${actualHeadSha}`);
  }

  const existingPr = findPrForBranch(branch, repo, runner);
  if (!existingPr) throw new Error(`repair target has no existing PR for ${branch}`);

  const dirty = String(runner("git", ["status", "--porcelain=v1"], { cwd: worktreePath })).trim();
  if (!dirty) throw new Error("repair worker produced no audited filesystem changes");
  runner("git", ["add", "--all"], { cwd: worktreePath });
  const staged = String(runner("git", ["diff", "--cached", "--name-only"], { cwd: worktreePath })).trim();
  if (!staged) throw new Error("repair changes produced an empty Git index");
  runner("git", ["commit", "-m", `fix: repair ${issue.identifier} CI failure`], { cwd: worktreePath });

  const afterCommit = String(runner("git", ["status", "--porcelain=v1"], { cwd: worktreePath })).trim();
  if (afterCommit) throw new Error("dispatcher repair commit did not leave a clean worktree");
  runner("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: worktreePath });

  const updatedPr = findPrForBranch(branch, repo, runner);
  if (!updatedPr || updatedPr.number !== existingPr.number) {
    throw new Error(`GitHub did not return the original PR for ${branch} after repair publication`);
  }
  return updatedPr;
}
