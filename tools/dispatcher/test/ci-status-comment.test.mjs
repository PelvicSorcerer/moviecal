// MOV-503: one CI status comment per PR, edited in place.
import { describe, expect, it, vi } from "vitest";
import { decideCiOutcome, reportObservationToLinear } from "../src/ci-outcomes.mjs";
import { LinearClient } from "../src/linear-client.mjs";
import { escalateToOwner } from "../src/owner-escalation.mjs";
import { reportReviewCi } from "../src/review-ci-observer.mjs";

const entry = { id: "MOV-1", status: "review", prNumber: 1, prUrl: "https://example.test/pr/1" };
const issue = {
  id: "linear-1", identifier: "MOV-1", url: "https://linear.app/moviecal/issue/MOV-1/x",
  assignee: { id: "user-adam", displayName: "adam" },
};

function observation(outcome, headSha = "head-1") {
  return {
    headSha,
    checks: {
      checks: [{ name: "lane-ios", sha: headSha, outcome, required: true }],
      required: [{ name: "lane-ios", outcome, required: true }],
      missingRequired: [], pending: outcome === "pending", timedOut: false,
    },
  };
}

function fakeStore() {
  const comments = []; // newest first
  let nextId = 1;
  const writes = [];
  return {
    comments, writes,
    issuesInState: async () => [issue],
    async issueCommentRecords(_id, { untilContains } = {}) {
      const read = [];
      for (let offset = 0; offset < comments.length; offset += 20) {
        const page = comments.slice(offset, offset + 20);
        read.push(...page);
        if (!untilContains || page.some((c) => c.body.includes(untilContains))) break;
      }
      return read.map((c) => ({ ...c }));
    },
    async addComment(_id, body) { writes.push("create"); comments.unshift({ id: `c${nextId++}`, body }); return true; },
    async commentUpdate(id, body) { writes.push("update"); comments.find((c) => c.id === id).body = body; return true; },
    async moveToState() { return true; },
  };
}

class Manager { loadState() { return { "MOV-1": entry }; } }

function argsFor(store, state, extra = {}) {
  return {
    linearClient: store, teamKey: "MOV", inReviewStateName: "In Review",
    WorktreeManager: Manager, worktreeManagerOptions: {},
    observePrFn: () => state.current, githubRepo: "owner/repo",
    decideCiOutcome, reportObservationToLinear, ...extra,
  };
}

describe("single CI status comment per PR", () => {
  it("creates one comment and edits it for each new snapshot on one head, with no duplicate after a restart", async () => {
    const store = fakeStore();
    const state = { current: observation("pending") };
    const args = argsFor(store, state);
    await reportReviewCi(args);
    await reportReviewCi(args); // unchanged: no write
    state.current = observation("failure");
    await reportReviewCi(args);
    await reportReviewCi({ ...args, WorktreeManager: class extends Manager {} }); // restart: no write
    state.current = observation("success");
    await reportReviewCi(args);
    state.current = observation("pending");
    state.current.checks.timedOut = true;
    await reportReviewCi(args);

    expect(store.writes).toEqual(["create", "update", "update", "update"]);
    expect(store.comments).toHaveLength(1);
    expect(store.comments[0].body).not.toContain("profiles/");
    // The edited body carries the current key, so the already-reported check holds.
    const before = store.writes.length;
    await reportReviewCi(args);
    expect(store.writes).toHaveLength(before);
  });

  it("starts a new comment for a new head SHA", async () => {
    const store = fakeStore();
    const state = { current: observation("pending") };
    const args = argsFor(store, state);
    await reportReviewCi(args);
    state.current = observation("pending", "head-2");
    await reportReviewCi(args);
    expect(store.writes).toEqual(["create", "create"]);
    expect(store.comments).toHaveLength(2);
  });

  it("keeps a terminal escalate as its own mention comment, once, and never mentions in status edits", async () => {
    const store = fakeStore();
    const keys = new Set();
    const ownerLedger = { hasEscalation: (k) => keys.has(k), recordEscalation: (k) => keys.add(k) };
    const state = { current: observation("pending") };
    const args = argsFor(store, state, { escalateToOwner, needsHumanDecisionStateId: "state-nhd", ownerLedger });
    await reportReviewCi(args);
    state.current = {
      headSha: "head-1",
      checks: {
        checks: [{ name: "permission-check", sha: "head-1", outcome: "failure", required: true }],
        required: [{ name: "permission-check", outcome: "failure", required: true }],
        missingRequired: [], pending: false, timedOut: false,
      },
    };
    await reportReviewCi(args);
    await reportReviewCi(args);

    const mentions = store.comments.filter((c) => c.body.includes("profiles/adam"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0].body.startsWith("Needs you: CI on PR #1")).toBe(true);
    const status = store.comments.filter((c) => c.body.startsWith("**CI observation (read-only)**"));
    expect(status).toHaveLength(1);
    expect(status[0].body).toContain("Decision: **escalate**");
    expect(status[0].body).not.toContain("profiles/");
  });
});

describe("LinearClient.commentUpdate", () => {
  it("sends a commentUpdate mutation with the id and body", async () => {
    const client = new LinearClient({ apiKey: "k" });
    const request = vi.spyOn(client, "request").mockResolvedValue({ commentUpdate: { success: true } });
    expect(await client.commentUpdate("c-1", "new body")).toBe(true);
    expect(request.mock.calls[0][0]).toContain("commentUpdate(id: $commentId");
    expect(request.mock.calls[0][1]).toEqual({ commentId: "c-1", body: "new body" });
  });
});
