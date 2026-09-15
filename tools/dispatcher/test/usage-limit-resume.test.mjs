import { describe, it, expect } from "vitest";
import { admitUsageLimitResume, RESUMABLE_STATUS } from "../src/usage-limit-resume.mjs";

const ISSUE_ID = "MOV-205";
const REPO = "owner/repo";
const BRANCH = "agent/MOV-205-resume-a-retained-worktree";
const WORKTREE = "/worktrees/moviecal/MOV-205-resume-a-retained-worktree";
const RETRY_AT = "2026-09-15T17:00:00.000Z";

const PLAN = {
  worktreePath: WORKTREE,
  branch: BRANCH,
  repository: REPO,
  retryAt: RETRY_AT,
  unpublishedPaths: ["tools/dispatcher/src/usage-limit.mjs"],
  scheduledAt: "2026-09-15T12:00:00.000Z",
  consumedAt: null,
};

const ENTRY = {
  id: ISSUE_ID,
  name: "MOV-205-resume-a-retained-worktree",
  branch: BRANCH,
  path: WORKTREE,
  status: RESUMABLE_STATUS,
  usageLimitResumeAt: RETRY_AT,
  retainedForResume: true,
  provenance: { executor: "moviecal-dispatcher", repository: REPO },
};

/** Every input in the shape a live, admissible resume presents them. */
function admissible(overrides = {}) {
  return admitUsageLimitResume({
    issueId: ISSUE_ID,
    plan: PLAN,
    entry: ENTRY,
    repository: REPO,
    branch: BRANCH,
    worktreePath: WORKTREE,
    dispatcherOwned: true,
    integrity: { intact: true, branch: BRANCH, reason: null },
    unpublishedPaths: ["tools/dispatcher/src/usage-limit.mjs"],
    ...overrides,
  });
}

describe("admitUsageLimitResume", () => {
  // Acceptance criterion: "The resumed worker runs only in that retained
  // worktree and same branch."
  it("admits a dispatcher-owned, intact, still-dirty retained worktree", () => {
    expect(admissible()).toEqual({ admitted: true, reasons: [], reason: null });
  });

  // Two spellings of one directory are one target. `reconcileStartup()`
  // already normalizes before comparing worktree paths; this does the same, so
  // a stray trailing slash cannot present as a hijacked resume.
  it("treats normalized-equivalent spellings of the same path as the same target", () => {
    expect(
      admissible({
        plan: { ...PLAN, worktreePath: `${WORKTREE}/` },
        entry: { ...ENTRY, path: `/worktrees/moviecal/./MOV-205-resume-a-retained-worktree` },
      }).admitted,
    ).toBe(true);
  });

  it("refuses when no resume was scheduled at all, and reports nothing else", () => {
    const verdict = admitUsageLimitResume({ issueId: ISSUE_ID });
    expect(verdict.admitted).toBe(false);
    // Deliberately the only reason: with no plan there is no target to judge,
    // and listing ten derived complaints would bury the actual one.
    expect(verdict.reasons).toEqual(["no scheduled retained-worktree resume was recorded for this issue"]);
  });

  // Acceptance criterion: "Before resuming, the dispatcher revalidates
  // dispatcher ownership, worktree integrity, branch/remote identity,
  // unchanged target provenance, and the normal worker safety boundary."
  //
  // (The safety boundary itself is not re-implemented here -- a resumed
  // worker is spawned through the same guarded path as any other, which
  // run-loop.test.mjs asserts.)
  it.each([
    [
      "the plan points at a different worktree path than this issue now resolves to",
      { plan: { ...PLAN, worktreePath: "/worktrees/moviecal/MOV-205-renamed" } },
      /is not this issue's current worktree path/,
    ],
    [
      "the plan points at a different branch",
      { plan: { ...PLAN, branch: "agent/MOV-205-renamed" } },
      /is not this issue's current branch/,
    ],
    [
      "the plan was scheduled against a different repository",
      { plan: { ...PLAN, repository: "someone/else" } },
      /not this dispatcher's/,
    ],
    ["there is no registry entry at all", { entry: null }, /no entry in the dispatcher worktree registry/],
    [
      "the registry entry moved to a different path",
      { entry: { ...ENTRY, path: "/worktrees/moviecal/elsewhere" } },
      /registry entry points at/,
    ],
    [
      "the registry entry moved to a different branch",
      { entry: { ...ENTRY, branch: "agent/MOV-205-something-else" } },
      /registry entry is on branch/,
    ],
    [
      "a worker is already active in the entry",
      { entry: { ...ENTRY, status: "active" } },
      /not the retained "failed" state/,
    ],
    [
      "the entry has since been published for review",
      { entry: { ...ENTRY, status: "review" } },
      /not the retained "failed" state/,
    ],
    [
      "the registry's scheduled reset disagrees with the durable record",
      { entry: { ...ENTRY, usageLimitResumeAt: "2026-09-15T21:00:00.000Z" } },
      /does not match the durable record/,
    ],
    [
      "the registry entry lost its scheduled-resume stamp entirely",
      { entry: { ...ENTRY, usageLimitResumeAt: undefined } },
      /does not match the durable record/,
    ],
    [
      "the entry carries no approved-executor provenance",
      { entry: { ...ENTRY, provenance: { executor: "someone-else", repository: REPO } } },
      /lacks approved-executor provenance/,
    ],
    [
      "the entry's provenance names a different repository",
      { entry: { ...ENTRY, provenance: { executor: "moviecal-dispatcher", repository: "someone/else" } } },
      /provenance does not match the configured repository/,
    ],
    [
      "the branch is outside this issue's dispatcher namespace",
      { branch: "agent/MOV-999-not-ours", plan: { ...PLAN, branch: "agent/MOV-999-not-ours" }, entry: { ...ENTRY, branch: "agent/MOV-999-not-ours" } },
      /outside the dispatcher issue namespace/,
    ],
    ["the worktree is not provably dispatcher-owned", { dispatcherOwned: false }, /not provably dispatcher-owned/],
    [
      "the worktree is no longer a readable Git worktree",
      { integrity: { intact: false, branch: null, reason: "retained worktree /x is no longer a readable Git worktree: boom" } },
      /no longer a readable Git worktree/,
    ],
    [
      "integrity could not be determined at all",
      { integrity: null },
      /could not be confirmed intact/,
    ],
    [
      "the unpublished work the resume existed to carry is gone",
      { unpublishedPaths: [] },
      /no longer holds the unpublished changes/,
    ],
    // "Unknown equals unknown" is the one comparison that must never admit.
    [
      "the plan carries no reset time to cross-check the registry against",
      { plan: { ...PLAN, retryAt: null }, entry: { ...ENTRY, usageLimitResumeAt: null } },
      /carries no scheduled reset time/,
    ],
    [
      "neither the plan nor the dispatcher names a repository",
      { plan: { ...PLAN, repository: null }, repository: null, entry: { ...ENTRY, provenance: { executor: "moviecal-dispatcher", repository: null } } },
      /provenance does not match the configured repository/,
    ],
    [
      "neither the plan nor the issue resolves to a branch",
      { plan: { ...PLAN, branch: null }, branch: null, entry: { ...ENTRY, branch: null } },
      /is not this issue's current branch/,
    ],
  ])("refuses when %s", (_label, overrides, expected) => {
    const verdict = admissible(overrides);
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toMatch(expected);
  });

  // A resume that cannot prove ownership must not be waved through just
  // because everything else looks right -- run-loop.mjs feeds "unknown" facts
  // in as `false`/`null`/`[]` precisely so they land on a refusal here.
  it("reports every failed check at once rather than only the first", () => {
    const verdict = admissible({
      dispatcherOwned: false,
      integrity: { intact: false, branch: null, reason: "gone" },
      unpublishedPaths: [],
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reasons).toHaveLength(3);
  });
});
