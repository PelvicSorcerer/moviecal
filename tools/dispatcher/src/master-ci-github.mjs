// The GitHub reads behind the post-merge master-failure observer (MOV-305).
//
// **Every function in this module is read-only.** There is no rerun, no
// dispatch, no comment, no push, and no `gh api` call with a method other
// than the implicit GET. That is a deliberate structural property, not a
// convention: `master` is protected at the GitHub level, and the observer's
// safety argument is that its GitHub adapter contains no mutation to reach in
// the first place. `dispatcher-wiring.test.mjs` asserts it against the source
// text so a future edit has to break a test to break the property.
//
// Every argument goes through execFileSync with no shell, exactly as
// pr-check.mjs and repair-github.mjs do.

import { execFileSync } from "node:child_process";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Completed `push` runs on `master`, newest first.
 *
 * The event/branch/status filters are applied server-side *and* re-applied by
 * `masterRunEligibility()` locally. That duplication is intentional: the
 * local rules are the ones under test, and a `gh` flag quietly changing
 * meaning must not be able to widen what counts as an incident.
 */
export function listMasterRuns({ repo, runner = defaultRunner, limit = 20 } = {}) {
  if (!repo) throw new Error("listMasterRuns requires a repository");
  const listed = parseJson(
    runner("gh", [
      "run",
      "list",
      "--repo",
      repo,
      "--branch",
      "master",
      "--event",
      "push",
      "--status",
      "completed",
      "--limit",
      String(limit),
      "--json",
      "databaseId,headBranch,headSha,event,status,conclusion,workflowName,name,createdAt,updatedAt,url",
    ]),
    [],
  );
  return Array.isArray(listed) ? listed : [];
}

/**
 * One run's full detail, including its attempt number and per-job
 * conclusions — the evidence the classifier reads. `attempt` is not available
 * from `gh run list`, and it is half of the incident's identity, so this call
 * is not optional.
 */
export function describeMasterRun({ repo, runId, runner = defaultRunner } = {}) {
  if (!repo || !runId) throw new Error("describeMasterRun requires repo and runId");
  return parseJson(
    runner("gh", [
      "run",
      "view",
      String(runId),
      "--repo",
      repo,
      "--json",
      "databaseId,attempt,conclusion,createdAt,event,headBranch,headSha,jobs,name,number,status,updatedAt,url,workflowName",
    ]),
    null,
  );
}

/** The pull requests GitHub itself associates with a commit. */
export function pullRequestsForCommit({ repo, sha, runner = defaultRunner } = {}) {
  if (!repo || !sha) throw new Error("pullRequestsForCommit requires repo and sha");
  const listed = parseJson(runner("gh", ["api", `repos/${repo}/commits/${sha}/pulls`]), []);
  return (Array.isArray(listed) ? listed : []).map((pr) => ({
    number: pr.number,
    url: pr.html_url || null,
    body: pr.body || "",
    merged: Boolean(pr.merged_at),
    baseRef: pr.base?.ref || null,
  }));
}

/**
 * The recent first-parent commit list of `master`, newest first — the only
 * lineage evidence `evaluateMasterLineage()` accepts. Read from the remote
 * rather than from a local checkout on purpose: the observer must never
 * depend on, or touch, any working tree.
 */
export function masterCommitLineage({ repo, runner = defaultRunner, limit = 30 } = {}) {
  if (!repo) throw new Error("masterCommitLineage requires a repository");
  const listed = parseJson(runner("gh", ["api", `repos/${repo}/commits?sha=master&per_page=${Number(limit) || 30}`]), []);
  return (Array.isArray(listed) ? listed : []).map((commit) => commit.sha).filter(Boolean);
}

/**
 * The merged pull request that carries a remediation issue's closing
 * keyword, if one exists yet. Matched on the issue identifier appearing in
 * the PR body — the same durable `Fixes MOV-NNN` reference every
 * dispatcher-created PR is required to carry.
 */
export function findMergedFixPullRequest({ repo, identifier, runner = defaultRunner, limit = 50 } = {}) {
  if (!repo || !identifier) throw new Error("findMergedFixPullRequest requires repo and identifier");
  const listed = parseJson(
    runner("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      String(limit),
      "--json",
      "number,url,body,mergedAt,mergeCommit,baseRefName",
    ]),
    [],
  );
  const pattern = new RegExp(`\\b${identifier.replace(/[^A-Za-z0-9-]/g, "")}\\b`, "i");
  const match = (Array.isArray(listed) ? listed : []).find(
    (pr) => pattern.test(String(pr.body || "")) && (!pr.baseRefName || pr.baseRefName === "master"),
  );
  if (!match) return null;
  return {
    number: match.number,
    url: match.url || null,
    mergedAt: match.mergedAt || null,
    mergeCommitSha: match.mergeCommit?.oid || null,
  };
}

/**
 * The most recent successful `push`-on-`master` run of one workflow. Whether
 * it actually closes an incident is `canCompleteMasterIncident()`'s decision,
 * not this function's — this only reports what GitHub says.
 */
export function latestSuccessfulMasterRun({ repo, workflowName, runner = defaultRunner, limit = 20 } = {}) {
  if (!repo || !workflowName) throw new Error("latestSuccessfulMasterRun requires repo and workflowName");
  const listed = parseJson(
    runner("gh", [
      "run",
      "list",
      "--repo",
      repo,
      "--branch",
      "master",
      "--event",
      "push",
      "--status",
      "success",
      "--limit",
      String(limit),
      "--json",
      "databaseId,headSha,conclusion,workflowName,createdAt,url",
    ]),
    [],
  );
  const runs = (Array.isArray(listed) ? listed : []).filter(
    (run) => String(run.workflowName || "").toLowerCase() === String(workflowName).toLowerCase(),
  );
  if (!runs.length) return null;
  const [newest] = runs;
  return {
    runId: newest.databaseId,
    headSha: newest.headSha,
    createdAt: newest.createdAt,
    url: newest.url || null,
    workflowName: newest.workflowName,
  };
}
