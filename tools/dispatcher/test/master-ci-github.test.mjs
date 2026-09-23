import { describe, expect, it } from "vitest";
import {
  describeMasterRun,
  findMergedFixPullRequest,
  latestSuccessfulMasterRun,
  listMasterRuns,
  masterCommitLineage,
  pullRequestsForCommit,
} from "../src/master-ci-github.mjs";

const REPO = "PelvicSorcerer/moviecal";

/** Records every invocation so the exact argv is assertable. */
function recorder(responses = {}) {
  const calls = [];
  const runner = (command, args) => {
    calls.push({ command, args });
    const key = args.join(" ");
    const match = Object.keys(responses).find((prefix) => key.includes(prefix));
    return match ? responses[match] : "[]";
  };
  runner.calls = calls;
  return runner;
}

describe("master CI GitHub reads (MOV-305)", () => {
  it("lists only completed push runs on master", () => {
    const runner = recorder({ "run list": JSON.stringify([{ databaseId: 1, headSha: "a" }]) });
    expect(listMasterRuns({ repo: REPO, runner, limit: 5 })).toEqual([{ databaseId: 1, headSha: "a" }]);
    const { args } = runner.calls[0];
    expect(args).toContain("--branch");
    expect(args[args.indexOf("--branch") + 1]).toBe("master");
    expect(args[args.indexOf("--event") + 1]).toBe("push");
    expect(args[args.indexOf("--status") + 1]).toBe("completed");
  });

  it("reads the attempt and per-job conclusions the classifier needs", () => {
    const runner = recorder({ "run view": JSON.stringify({ databaseId: 1, attempt: 2, jobs: [{ name: "lane-ios", conclusion: "failure" }] }) });
    expect(describeMasterRun({ repo: REPO, runId: 1, runner })).toMatchObject({ attempt: 2 });
    expect(runner.calls[0].args.join(" ")).toMatch(/attempt/);
    expect(runner.calls[0].args.join(" ")).toMatch(/jobs/);
  });

  it("normalizes the commit's associated pull requests", () => {
    const runner = recorder({
      "commits/abc/pulls": JSON.stringify([
        { number: 602, html_url: "https://github.test/pull/602", body: "Linear: MOV-293", merged_at: "2026-09-22T00:00:00Z", base: { ref: "master" } },
      ]),
    });
    expect(pullRequestsForCommit({ repo: REPO, sha: "abc", runner })).toEqual([
      { number: 602, url: "https://github.test/pull/602", body: "Linear: MOV-293", merged: true, baseRef: "master" },
    ]);
  });

  it("reads master's recent lineage newest-first from the remote, never a checkout", () => {
    const runner = recorder({ "commits?sha=master": JSON.stringify([{ sha: "c3" }, { sha: "c2" }]) });
    expect(masterCommitLineage({ repo: REPO, runner, limit: 2 })).toEqual(["c3", "c2"]);
    expect(runner.calls[0].command).toBe("gh");
  });

  it("finds the merged fix PR by the remediation identifier in its body", () => {
    const runner = recorder({
      "pr list": JSON.stringify([
        { number: 699, body: "unrelated", baseRefName: "master" },
        { number: 700, url: "u", body: "Fixes MOV-900", mergedAt: "2026-09-24T00:00:00Z", mergeCommit: { oid: "m1" }, baseRefName: "master" },
      ]),
    });
    expect(findMergedFixPullRequest({ repo: REPO, identifier: "MOV-900", runner })).toEqual({
      number: 700,
      url: "u",
      mergedAt: "2026-09-24T00:00:00Z",
      mergeCommitSha: "m1",
    });
    expect(findMergedFixPullRequest({ repo: REPO, identifier: "MOV-901", runner })).toBeNull();
  });

  it("returns the newest successful master run of one workflow, ignoring the others", () => {
    const runner = recorder({
      "run list": JSON.stringify([
        { databaseId: 10, headSha: "c3", workflowName: "verify", createdAt: "2026-09-24T00:00:00Z" },
        { databaseId: 9, headSha: "c2", workflowName: "ios-verify", createdAt: "2026-09-23T00:00:00Z" },
      ]),
    });
    expect(latestSuccessfulMasterRun({ repo: REPO, workflowName: "ios-verify", runner })).toMatchObject({ headSha: "c2" });
    expect(latestSuccessfulMasterRun({ repo: REPO, workflowName: "browser-verify", runner })).toBeNull();
  });

  it("degrades to an empty result on unparseable output rather than throwing into the poll loop", () => {
    const runner = () => "not json";
    expect(listMasterRuns({ repo: REPO, runner })).toEqual([]);
    expect(masterCommitLineage({ repo: REPO, runner })).toEqual([]);
    expect(pullRequestsForCommit({ repo: REPO, sha: "abc", runner })).toEqual([]);
    expect(describeMasterRun({ repo: REPO, runId: 1, runner })).toBeNull();
  });

  it("requires its identifying arguments rather than silently querying the wrong thing", () => {
    expect(() => listMasterRuns({})).toThrow(/repository/);
    expect(() => describeMasterRun({ repo: REPO })).toThrow(/repo and runId/);
    expect(() => pullRequestsForCommit({ repo: REPO })).toThrow(/repo and sha/);
    expect(() => findMergedFixPullRequest({ repo: REPO })).toThrow(/repo and identifier/);
    expect(() => latestSuccessfulMasterRun({ repo: REPO })).toThrow(/repo and workflowName/);
  });

  it("never issues a mutating GitHub command", () => {
    const runner = recorder();
    listMasterRuns({ repo: REPO, runner });
    describeMasterRun({ repo: REPO, runId: 1, runner });
    pullRequestsForCommit({ repo: REPO, sha: "abc", runner });
    masterCommitLineage({ repo: REPO, runner });
    findMergedFixPullRequest({ repo: REPO, identifier: "MOV-900", runner });
    latestSuccessfulMasterRun({ repo: REPO, workflowName: "verify", runner });

    // Check the *verb* positions, not every argument: `--event push` is a
    // filter value, and matching it as a command would make this vacuous.
    const readOnlyVerbs = ["run list", "run view", "pr list", "api"];
    for (const call of runner.calls) {
      expect(call.command).toBe("gh");
      const verb = call.args[0] === "api" ? "api" : call.args.slice(0, 2).join(" ");
      expect(readOnlyVerbs, `${call.args.join(" ")} uses an unexpected verb`).toContain(verb);
      // `gh api` defaults to GET; anything else has to ask for it explicitly.
      for (const methodFlag of ["--method", "-X", "-f", "--field", "--input"]) {
        expect(call.args.includes(methodFlag), `${call.args.join(" ")} contains ${methodFlag}`).toBe(false);
      }
    }
  });
});
