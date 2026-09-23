import { describe, expect, it } from "vitest";
import {
  describeMasterRun,
  findMergedFixPullRequest,
  latestSuccessfulMasterRun,
  listMasterRuns,
  masterCommitLineage,
  pullRequestsForCommit,
} from "../src/master-ci-github.mjs";

function runner(output = "[]") {
  const calls = [];
  return {
    calls,
    run(command, args) { calls.push({ command, args }); return output; },
  };
}

describe("master CI GitHub adapter (MOV-316)", () => {
  it("uses only read-only gh run and API requests for every observation", () => {
    const stub = runner(JSON.stringify([{ databaseId: 42, workflowName: "verify", headSha: "bad" }]));
    listMasterRuns({ repo: "owner/repo", runner: stub.run });
    describeMasterRun({ repo: "owner/repo", runId: 42, runner: stub.run });
    pullRequestsForCommit({ repo: "owner/repo", sha: "bad", runner: stub.run });
    masterCommitLineage({ repo: "owner/repo", runner: stub.run });
    findMergedFixPullRequest({ repo: "owner/repo", identifier: "MOV-999", runner: stub.run });
    latestSuccessfulMasterRun({ repo: "owner/repo", workflowName: "verify", runner: stub.run });
    expect(stub.calls).toEqual(expect.arrayContaining([
      { command: "gh", args: expect.arrayContaining(["run", "list"]) },
      { command: "gh", args: expect.arrayContaining(["run", "view", "42"]) },
      { command: "gh", args: expect.arrayContaining(["api", "repos/owner/repo/commits/bad/pulls"]) },
      { command: "gh", args: expect.arrayContaining(["api", "repos/owner/repo/commits?sha=master&per_page=30"]) },
      { command: "gh", args: expect.arrayContaining(["pr", "list", "--state", "merged"]) },
    ]));
    for (const { command, args } of stub.calls) {
      expect(command).toBe("gh");
      // `push` and `merged` are required read filters; a `gh api` mutation
      // needs an explicit method, which the adapter never supplies.
      expect(args).not.toContain("--method");
      expect(args).not.toContain("rerun");
    }
  });

  it("preserves run jobs, source attribution, master lineage, and successful workflow facts", () => {
    const run = runner(JSON.stringify({ databaseId: 42, jobs: [{ name: "lane-unit", conclusion: "failure" }] }));
    expect(describeMasterRun({ repo: "owner/repo", runId: 42, runner: run.run })).toMatchObject({ databaseId: 42, jobs: [{ name: "lane-unit" }] });
    const prs = runner(JSON.stringify([{ number: 9, html_url: "https://example.test/9", body: "Fixes MOV-9", merged_at: "now", base: { ref: "master" } }]));
    expect(pullRequestsForCommit({ repo: "owner/repo", sha: "good", runner: prs.run })).toMatchObject([{ number: 9, merged: true, baseRef: "master" }]);
    const commits = runner(JSON.stringify([{ sha: "new" }, { sha: "old" }]));
    expect(masterCommitLineage({ repo: "owner/repo", runner: commits.run })).toEqual(["new", "old"]);
    const successes = runner(JSON.stringify([{ databaseId: 42, headSha: "good", workflowName: "verify", createdAt: "now" }]));
    expect(latestSuccessfulMasterRun({ repo: "owner/repo", workflowName: "verify", runner: successes.run })).toMatchObject({ runId: 42, headSha: "good" });
  });

  it("finds only merged master fix PRs that reference the remediation issue", () => {
    const stub = runner(JSON.stringify([
      { number: 1, body: "Fixes MOV-999", baseRefName: "feature" },
      { number: 2, body: "Fixes MOV-999", baseRefName: "master", mergeCommit: { oid: "merge" } },
    ]));
    expect(findMergedFixPullRequest({ repo: "owner/repo", identifier: "MOV-999", runner: stub.run })).toEqual({ number: 2, url: null, mergedAt: null, mergeCommitSha: "merge" });
  });
});
