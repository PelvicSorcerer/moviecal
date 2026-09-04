import { describe, it, expect } from "vitest";
import { evaluatePreflight, slugify, worktreeName, branchName } from "../src/preflight.mjs";

function baseContext(overrides = {}) {
  return {
    isIssueSatisfied: () => true,
    iosRunnerOnline: true,
    activeWorktreeCount: 0,
    concurrencyLimit: 2,
    secretPresent: () => true,
    worktreePathFree: () => true,
    candidateWorktreePath: "/tmp/worktree",
    ...overrides,
  };
}

describe("evaluatePreflight", () => {
  it("passes a clean issue", () => {
    const result = evaluatePreflight({ labels: [], blockedByIds: [] }, baseContext());
    expect(result.ok).toBe(true);
  });

  it("blocks human-only issues unconditionally", () => {
    const result = evaluatePreflight({ labels: ["human-only"], blockedByIds: [] }, baseContext());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/human-only/);
  });

  it("blocks on unresolved blocking relations", () => {
    const context = baseContext({ isIssueSatisfied: (id) => id !== "MOV-1" });
    const result = evaluatePreflight({ labels: [], blockedByIds: ["MOV-1", "MOV-2"] }, context);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/MOV-1/);
    expect(result.reason).not.toMatch(/MOV-2/);
  });

  it("passes when all blocking relations are satisfied", () => {
    const result = evaluatePreflight(
      { labels: [], blockedByIds: ["MOV-1", "MOV-2"] },
      baseContext(),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks needs-secrets when the secret is absent", () => {
    const context = baseContext({ secretPresent: () => false });
    const result = evaluatePreflight({ labels: ["needs-secrets"], blockedByIds: [] }, context);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/needs-secrets/);
  });

  it("passes needs-secrets when the named secret is present", () => {
    const context = baseContext({ secretPresent: (name) => name === "TMDB_API_KEY" });
    const result = evaluatePreflight(
      { labels: ["needs-secrets", "needs-secret:TMDB_API_KEY"], blockedByIds: [] },
      context,
    );
    expect(result.ok).toBe(true);
  });

  it("blocks iOS project work when the self-hosted runner is offline", () => {
    const context = baseContext({ iosRunnerOnline: false });
    const result = evaluatePreflight(
      { labels: [], blockedByIds: [], project: "iOS Companion App" },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/runner/);
  });

  it("does not gate non-iOS projects on runner availability", () => {
    const context = baseContext({ iosRunnerOnline: false });
    const result = evaluatePreflight(
      { labels: [], blockedByIds: [], project: "Calendar Feed" },
      context,
    );
    expect(result.ok).toBe(true);
  });

  it("blocks when the concurrency limit is reached", () => {
    const context = baseContext({ activeWorktreeCount: 2, concurrencyLimit: 2 });
    const result = evaluatePreflight({ labels: [], blockedByIds: [] }, context);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/concurrency/);
  });

  it("blocks when the candidate worktree path is already in use", () => {
    const context = baseContext({ worktreePathFree: () => false });
    const result = evaluatePreflight({ labels: [], blockedByIds: [] }, context);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already in use/);
  });
});

describe("slugify / worktreeName / branchName", () => {
  it("slugifies a title into a branch-safe fragment", () => {
    expect(slugify("Wire up TMDB_API_KEY and SMOKE_URL secrets")).toBe(
      "wire-up-tmdb-api-key-and-smoke-url-secre",
    );
  });

  it("builds a worktree name from identifier + slug", () => {
    expect(worktreeName("MOV-42", "Fix the thing")).toBe("MOV-42-fix-the-thing");
  });

  it("builds a branch name prefixed with agent/", () => {
    expect(branchName("MOV-42", "Fix the thing")).toBe("agent/MOV-42-fix-the-thing");
  });
});
