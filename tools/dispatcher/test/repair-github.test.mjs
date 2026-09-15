import { describe, it, expect, vi } from "vitest";
import { collectRepairEvidence, commentOnPullRequest, rerunFailedJobs } from "../src/repair-github.mjs";

const REPO = "owner/repo";
const HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const OTHER = "ffffffffffffffffffffffffffffffffffffffff";

/** A `gh` stub that answers `run list` from a fixture and records every call. */
function ghStub(runs, { rerunFails = new Set() } = {}) {
  const calls = [];
  const runner = vi.fn((command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "run" && args[1] === "list") return JSON.stringify(runs);
    if (args[0] === "run" && args[1] === "rerun") {
      if (rerunFails.has(Number(args[2]))) throw new Error("HTTP 403");
      return "";
    }
    return "";
  });
  return { runner, calls };
}

describe("rerunFailedJobs", () => {
  it("reruns only the failed jobs of failed runs on the admitted commit", () => {
    const { runner, calls } = ghStub([
      { databaseId: 1, headSha: HEAD, conclusion: "failure", workflowName: "verify" },
      { databaseId: 2, headSha: HEAD, conclusion: "success", workflowName: "browser-verify" },
    ]);

    const result = rerunFailedJobs({ prNumber: 7, repo: REPO, headSha: HEAD, runner });

    expect(result.rerun).toEqual([{ id: 1, name: "verify", conclusion: "failure" }]);
    expect(result.skipped).toHaveLength(1);
    // `--failed` is what keeps a passing job from being re-executed.
    expect(calls).toContainEqual(["gh", "run", "rerun", "1", "--failed", "--repo", REPO]);
    expect(calls.some((c) => c.includes("2"))).toBe(false);
  });

  it("scopes the listing to the admitted commit, and re-checks it locally", () => {
    const { runner, calls } = ghStub([
      { databaseId: 3, headSha: OTHER, conclusion: "failure", workflowName: "verify" },
    ]);

    const result = rerunFailedJobs({ prNumber: 7, repo: REPO, headSha: HEAD, runner });

    expect(result.rerun).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/not the admitted head/);
    expect(calls[0]).toContain("--commit");
    expect(calls[0]).toContain(HEAD);
  });

  it.each([["success"], ["skipped"], ["neutral"], [""]])(
    "does not rerun a run whose conclusion is %s",
    (conclusion) => {
      const { runner } = ghStub([{ databaseId: 4, headSha: HEAD, conclusion, workflowName: "verify" }]);
      expect(rerunFailedJobs({ prNumber: 7, repo: REPO, headSha: HEAD, runner }).rerun).toEqual([]);
    },
  );

  it("reports a rerun that GitHub refused without losing the ones that worked", () => {
    const { runner } = ghStub(
      [
        { databaseId: 5, headSha: HEAD, conclusion: "timed_out", workflowName: "browser-verify" },
        { databaseId: 6, headSha: HEAD, conclusion: "cancelled", workflowName: "verify" },
      ],
      { rerunFails: new Set([6]) },
    );

    const result = rerunFailedJobs({ prNumber: 7, repo: REPO, headSha: HEAD, runner });

    expect(result.rerun.map((r) => r.id)).toEqual([5]);
    expect(result.errors).toMatchObject([{ id: 6, message: expect.stringContaining("403") }]);
  });

  it("refuses to run at all without an admitted head SHA", () => {
    expect(() => rerunFailedJobs({ prNumber: 7, repo: REPO, runner: vi.fn() })).toThrow(/admitted head SHA/);
  });
});

describe("commentOnPullRequest", () => {
  it("posts a plain comment, never a review", () => {
    const runner = vi.fn(() => "");
    commentOnPullRequest({ prNumber: 7, repo: REPO, body: "hello", runner });
    expect(runner).toHaveBeenCalledWith("gh", ["pr", "comment", "7", "--repo", REPO, "--body", "hello"]);
  });

  it("requires a PR to comment on", () => {
    expect(() => commentOnPullRequest({ repo: REPO, body: "x", runner: vi.fn() })).toThrow(/prNumber/);
  });
});

describe("collectRepairEvidence", () => {
  it("gathers logs, body, diff, and review comments for the admitted commit", () => {
    const runner = vi.fn((_command, args) => {
      if (args[0] === "run" && args[1] === "list") {
        return JSON.stringify([{ databaseId: 1, headSha: HEAD, conclusion: "failure", workflowName: "verify" }]);
      }
      if (args[0] === "run" && args[1] === "view") return "AssertionError: expected 1 to be 2";
      if (args[0] === "pr" && args[1] === "diff") return "--- a/src/x.ts\n+++ b/src/x.ts";
      if (args.includes("body")) return JSON.stringify({ body: "## Summary" });
      return JSON.stringify({
        reviews: [{ state: "REQUEST_CHANGES", author: { login: "PelvicSorcerer" }, body: "fix the null check" }],
        comments: [],
      });
    });

    const evidence = collectRepairEvidence({ prNumber: 7, repo: REPO, headSha: HEAD, runner });

    expect(evidence.ciLogs).toContain("AssertionError: expected 1 to be 2");
    expect(evidence.prBody).toContain("## Summary");
    expect(evidence.diff).toContain("src/x.ts");
    expect(evidence.reviewComments).toContain("fix the null check");
  });

  // Evidence is an input to a brief, not a gate. A missing log makes the brief
  // worse; it must never turn into a failed repair or a thrown exception in
  // the middle of the poll cycle.
  it("degrades to a note rather than throwing when gh fails", () => {
    const runner = vi.fn(() => {
      throw new Error("gh: not authenticated");
    });
    const evidence = collectRepairEvidence({ prNumber: 7, repo: REPO, headSha: HEAD, runner });
    for (const value of Object.values(evidence)) {
      expect(value).toMatch(/unavailable: gh: not authenticated/);
    }
  });
});
