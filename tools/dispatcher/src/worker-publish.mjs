// Privileged publication boundary for dispatcher workers (MOV-145).
//
// Workers produce filesystem changes but receive no Git or GitHub mutation
// authority. Only this trusted dispatcher-side function stages and commits the
// audited changes, pushes the exact assigned branch (never with force), and
// creates the draft PR after worker-guard validation.

import { execFileSync } from "node:child_process";
import { findPrForBranch, findAnyPrForBranch } from "./pr-check.mjs";
import { pullRequestReadinessEvidence } from "./readiness-evidence.mjs";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

function humanReviewNote(humanReviewPaths) {
  return [
    "## Human Review Required",
    "",
    `Migration or auth/calendar-token change requires human review: ${humanReviewPaths.map((file) => `\`${file}\``).join(", ")}.`,
    "The repo owner must provide the `sensitive-path-ack` label and a `lane-review-ack: <reason>` PR body line before merge.",
  ].join("\n");
}

export function pullRequestBody(issue, verificationEvidence, humanReviewPaths = []) {
  return [
    "## Summary",
    "",
    `Implements ${issue.identifier}: ${issue.title}`,
    "",
    "## Test Impact",
    "",
    "- Automated coverage and any deferred coverage remain subject to the Linear issue's Testing Expectations and human review.",
    "- GitHub CI remains authoritative for required-check results.",
    ...(humanReviewPaths.length ? ["", humanReviewNote(humanReviewPaths)] : []),
    "",
    "## Verification",
    "",
    verificationEvidence?.status === "passed"
      ? "- [x] `npm run verify` (dispatcher-captured structured result)"
      : "- [ ] `npm run verify` (no durable passing dispatcher record)",
    "",
    pullRequestReadinessEvidence(issue, verificationEvidence, { humanReviewPaths }),
    "",
    `**Linear:** Fixes ${issue.identifier}`,
    "",
    `Fixes ${issue.identifier}`,
  ].join("\n");
}

/**
 * Commit, push, and find/create one draft PR. Every argument is passed through
 * execFileSync (no shell), branch identity is checked again immediately
 * before the push, and a non-fast-forward remote rejects naturally.
 */
export function publishWorkerResult({ worktreePath, branch, repo, issue, verificationEvidence, humanReviewPaths = [], allowExistingCommits = false, requireNewPr = false, runner = defaultRunner } = {}) {
  if (!branch?.startsWith(`agent/${issue?.identifier}-`)) {
    throw new Error("assigned branch does not match the dispatcher issue namespace");
  }
  const actualBranch = String(runner("git", ["branch", "--show-current"], { cwd: worktreePath })).trim();
  if (actualBranch !== branch) throw new Error(`refusing to publish ${actualBranch || "detached HEAD"}; expected ${branch}`);
  if (requireNewPr && findAnyPrForBranch(branch, repo, runner)) throw new Error(`branch ${branch} already has a PR; use repair`);

  const dirty = String(runner("git", ["status", "--porcelain=v1"], { cwd: worktreePath })).trim();
  if (!dirty && !allowExistingCommits) throw new Error("worker produced no audited filesystem changes");
  if (dirty) {
    runner("git", ["add", "--all", "--", ".", ":!WORKER_PROGRESS.md"], { cwd: worktreePath });
    const staged = String(runner("git", ["diff", "--cached", "--name-only"], { cwd: worktreePath })).trim();
    if (!staged) throw new Error("worker changes produced an empty Git index");
    if (staged.split("\n").includes("WORKER_PROGRESS.md")) throw new Error("refusing to publish worker progress file");
    runner("git", ["commit", "-m", `fix: ${issue.identifier} ${issue.title}`], { cwd: worktreePath });
  }

  const afterCommit = String(runner("git", ["status", "--porcelain=v1"], { cwd: worktreePath })).trim();
  if (afterCommit) throw new Error("dispatcher commit did not leave a clean worktree");
  const ahead = Number(String(runner("git", ["rev-list", "--count", "origin/master..HEAD"], { cwd: worktreePath })).trim());
  if (!Number.isInteger(ahead) || ahead < 1) throw new Error("dispatcher produced no commit ahead of origin/master");

  if (requireNewPr && findAnyPrForBranch(branch, repo, runner)) throw new Error(`branch ${branch} gained a PR before publication; use repair`);

  runner("git", ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], { cwd: worktreePath });
  if (requireNewPr && findAnyPrForBranch(branch, repo, runner)) {
    throw new Error(`branch ${branch} gained a PR during publication; use repair`);
  }
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
      pullRequestBody(issue, verificationEvidence, humanReviewPaths),
    ], { cwd: worktreePath });
    pr = findPrForBranch(branch, repo, runner);
  } else if (humanReviewPaths.length) {
    // A retry may reuse a PR whose prior body predates the sensitive diff.
    // Keep human-authored evidence, but restore the required draft handoff.
    if (!pr.isDraft) runner("gh", ["pr", "ready", String(pr.number), "--undo", "--repo", repo], { cwd: worktreePath });
    const { body = "" } = JSON.parse(runner("gh", ["pr", "view", String(pr.number), "--repo", repo, "--json", "body"], { cwd: worktreePath }));
    const disabledBody = /^Autonomy:[^\r\n]*$/im.test(body)
      ? body.replace(/^Autonomy:[^\r\n]*$/gim, "Autonomy: disabled")
      : `${body}\n\nAutonomy: disabled`;
    const reviewNote = humanReviewNote(humanReviewPaths);
    runner("gh", ["pr", "edit", String(pr.number), "--repo", repo, "--body",
      disabledBody.includes(reviewNote) ? disabledBody : `${disabledBody}\n\n${reviewNote}`], { cwd: worktreePath });
    pr = findPrForBranch(branch, repo, runner);
  }
  if (!pr) throw new Error(`GitHub did not return a PR for ${branch} after creation`);
  return pr;
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
