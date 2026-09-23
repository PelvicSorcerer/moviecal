// The GitHub reads behind the post-merge master-failure observer (MOV-316).
//
// Every function in this module is read-only. There is no rerun, dispatch,
// comment, push, or mutating `gh api` call. Use execFileSync without a shell.

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

/** Completed push runs on master, newest first. */
export function listMasterRuns({ repo, runner = defaultRunner, limit = 20 } = {}) {
  if (!repo) throw new Error("listMasterRuns requires a repository");
  const listed = parseJson(
    runner("gh", [
      "run", "list", "--repo", repo, "--branch", "master", "--event", "push", "--status", "completed", "--limit", String(limit),
      "--json", "databaseId,headBranch,headSha,event,status,conclusion,workflowName,name,createdAt,updatedAt,url",
    ]),
    [],
  );
  return Array.isArray(listed) ? listed : [];
}

/** One run's attempt number and job conclusions. */
export function describeMasterRun({ repo, runId, runner = defaultRunner } = {}) {
  if (!repo || !runId) throw new Error("describeMasterRun requires repo and runId");
  return parseJson(
    runner("gh", [
      "run", "view", String(runId), "--repo", repo, "--json",
      "databaseId,attempt,conclusion,createdAt,event,headBranch,headSha,jobs,name,number,status,updatedAt,url,workflowName",
    ]),
    null,
  );
}

/** Pull requests GitHub associates with a commit. */
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

/** Recent first-parent commit list of master, newest first, read remotely. */
export function masterCommitLineage({ repo, runner = defaultRunner, limit = 30 } = {}) {
  if (!repo) throw new Error("masterCommitLineage requires a repository");
  const listed = parseJson(runner("gh", ["api", `repos/${repo}/commits?sha=master&per_page=${Number(limit) || 30}`]), []);
  return (Array.isArray(listed) ? listed : []).map((commit) => commit.sha).filter(Boolean);
}

/** A merged PR whose body references this remediation issue. */
export function findMergedFixPullRequest({ repo, identifier, runner = defaultRunner, limit = 50 } = {}) {
  if (!repo || !identifier) throw new Error("findMergedFixPullRequest requires repo and identifier");
  const listed = parseJson(
    runner("gh", [
      "pr", "list", "--repo", repo, "--state", "merged", "--limit", String(limit), "--json",
      "number,url,body,mergedAt,mergeCommit,baseRefName",
    ]),
    [],
  );
  const pattern = new RegExp(`\\b${identifier.replace(/[^A-Za-z0-9-]/g, "")}\\b`, "i");
  const match = (Array.isArray(listed) ? listed : []).find(
    (pr) => pattern.test(String(pr.body || "")) && (!pr.baseRefName || pr.baseRefName === "master"),
  );
  if (!match) return null;
  return { number: match.number, url: match.url || null, mergedAt: match.mergedAt || null, mergeCommitSha: match.mergeCommit?.oid || null };
}

/** Most recent successful push-on-master run for one workflow. */
export function latestSuccessfulMasterRun({ repo, workflowName, runner = defaultRunner, limit = 20 } = {}) {
  if (!repo || !workflowName) throw new Error("latestSuccessfulMasterRun requires repo and workflowName");
  const listed = parseJson(
    runner("gh", [
      "run", "list", "--repo", repo, "--branch", "master", "--event", "push", "--status", "success", "--limit", String(limit),
      "--json", "databaseId,headSha,conclusion,workflowName,createdAt,url",
    ]),
    [],
  );
  const newest = (Array.isArray(listed) ? listed : []).find(
    (run) => String(run.workflowName || "").toLowerCase() === String(workflowName).toLowerCase(),
  );
  return newest
    ? { runId: newest.databaseId, headSha: newest.headSha, createdAt: newest.createdAt, url: newest.url || null, workflowName: newest.workflowName }
    : null;
}
