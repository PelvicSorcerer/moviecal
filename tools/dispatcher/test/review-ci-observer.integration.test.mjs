import { describe, expect, it } from "vitest";
import { decideCiOutcome, reportObservationToLinear } from "../src/ci-outcomes.mjs";
import { reportReviewCi } from "../src/review-ci-observer.mjs";

const entry = { id: "MOV-1", status: "review", prNumber: 1, prUrl: "https://example.test/pr/1" };

function observation(outcome) {
  return {
    headSha: "head-1",
    checks: {
      checks: [{ name: "lane-ios", sha: "head-1", outcome, required: true }],
      required: [{ name: "lane-ios", outcome, required: true }],
      missingRequired: [],
      pending: outcome === "pending",
      timedOut: false,
    },
  };
}

describe("review CI observation polling (MOV-298)", () => {
  it("reports a terminal failure after a pending snapshot while another dispatch worker is active", async () => {
    let current = observation("pending");
    const comments = [];
    const linearClient = {
      issuesInState: async () => [{ id: "linear-1", identifier: "MOV-1" }],
      issueComments: async () => comments.map((comment) => comment.body),
      addComment: async (_id, body) => comments.push({ body }),
    };
    class ActiveWorkerManager {
      constructor() { this.activeCount = () => 1; }
      loadState() { return { "MOV-1": entry }; }
    }
    const args = {
      linearClient,
      teamKey: "MOV",
      inReviewStateName: "In Review",
      WorktreeManager: ActiveWorkerManager,
      worktreeManagerOptions: {},
      observePrFn: () => current,
      githubRepo: "owner/repo",
      decideCiOutcome,
      reportObservationToLinear,
    };

    await reportReviewCi(args);
    current = observation("failure");
    await reportReviewCi(args);
    await reportReviewCi(args);

    expect(comments).toHaveLength(2);
    expect(comments[0].body).toContain("Decision: **provisional**");
    expect(comments[1].body).toContain("Decision: **propose-code-repair**");
  });
});
