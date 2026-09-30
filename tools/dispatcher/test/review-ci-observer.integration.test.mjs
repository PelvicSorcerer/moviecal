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

/**
 * A minimal stand-in for Linear's real comment store: newest-first order,
 * and `issueComments` only ever returns the newest 20 — exactly the shape
 * `first: 20` gives the real LinearClient. This is what let the pre-MOV-423
 * `last: 20` read silently break deduplication: an issue with more than 20
 * comments buried the observer's own most recent comment behind that many
 * older, unrelated ones, so the duplicate check never found it.
 */
function fakeLinearComments(prewrittenCount) {
  const comments = [];
  for (let i = 0; i < prewrittenCount; i++) comments.unshift(`unrelated human comment #${i}`);
  return {
    comments,
    async issueComments() {
      return comments.slice(0, 20);
    },
    async addComment(_id, body) {
      comments.unshift(body);
      return true;
    },
  };
}

describe("review CI observation deduplication on a long comment history (MOV-423)", () => {
  it("publishes an unchanged observation at most once even with more than 20 prior comments, across polls and a simulated restart", async () => {
    const store = fakeLinearComments(25);
    const linearClient = {
      issuesInState: async () => [{ id: "linear-1", identifier: "MOV-1" }],
      issueComments: store.issueComments,
      addComment: store.addComment,
    };
    class ReviewWorktreeManager {
      constructor() { this.activeCount = () => 0; }
      loadState() { return { "MOV-1": entry }; }
    }
    const args = {
      linearClient,
      teamKey: "MOV",
      inReviewStateName: "In Review",
      WorktreeManager: ReviewWorktreeManager,
      worktreeManagerOptions: {},
      observePrFn: () => observation("pending"),
      githubRepo: "owner/repo",
      decideCiOutcome,
      reportObservationToLinear,
    };

    await reportReviewCi(args);
    // Repeated polls against the unchanged pending snapshot.
    await reportReviewCi(args);
    await reportReviewCi(args);
    // A fresh WorktreeManager/observer instance stands in for a dispatcher
    // restart: nothing about deduplication may live only in this process's
    // memory, since the check re-reads Linear's own comments every time.
    await reportReviewCi({ ...args, WorktreeManager: class extends ReviewWorktreeManager {} });

    const observationComments = store.comments.filter((body) => body.includes("ci-observation:"));
    expect(observationComments).toHaveLength(1);
    expect(observationComments[0]).toContain("Decision: **provisional**");
  });

  it("publishes exactly one new observation on a pending-to-terminal transition, then stays silent", async () => {
    const store = fakeLinearComments(25);
    const linearClient = {
      issuesInState: async () => [{ id: "linear-1", identifier: "MOV-1" }],
      issueComments: store.issueComments,
      addComment: store.addComment,
    };
    class ReviewWorktreeManager {
      constructor() { this.activeCount = () => 0; }
      loadState() { return { "MOV-1": entry }; }
    }
    let current = observation("pending");
    const args = {
      linearClient,
      teamKey: "MOV",
      inReviewStateName: "In Review",
      WorktreeManager: ReviewWorktreeManager,
      worktreeManagerOptions: {},
      observePrFn: () => current,
      githubRepo: "owner/repo",
      decideCiOutcome,
      reportObservationToLinear,
    };

    await reportReviewCi(args);
    current = observation("failure");
    await reportReviewCi(args);
    // Later unchanged polls against the same terminal snapshot stay silent,
    // even after a simulated restart.
    await reportReviewCi(args);
    await reportReviewCi({ ...args, WorktreeManager: class extends ReviewWorktreeManager {} });

    const observationComments = store.comments.filter((body) => body.includes("ci-observation:"));
    expect(observationComments).toHaveLength(2);
    expect(observationComments[0]).toContain("Decision: **propose-code-repair**");
    expect(observationComments[1]).toContain("Decision: **provisional**");
  });
});
