import { describe, it, expect } from "vitest";
import {
  evaluatePreflight,
  slugify,
  worktreeName,
  branchName,
  resolveWorkflowEditAuthorization,
} from "../src/preflight.mjs";

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

describe("resolveWorkflowEditAuthorization", () => {
  it("is not authorized, with no reason, for an ordinary issue", () => {
    const result = resolveWorkflowEditAuthorization({ labels: [], description: "Just fix a bug." });
    expect(result).toEqual({ authorized: false, reason: null });
  });

  it("authorizes when the label and exactly one valid marker are both present", () => {
    const result = resolveWorkflowEditAuthorization({
      labels: ["ci:workflow-edit-authorized"],
      description: "Some text.\n\nWorkflow-edit: .github/workflows/ios-verify.yml\n\nMore text.",
    });
    expect(result).toEqual({ authorized: true, path: ".github/workflows/ios-verify.yml" });
  });

  it("fails closed when labeled but no marker is present", () => {
    const result = resolveWorkflowEditAuthorization({
      labels: ["ci:workflow-edit-authorized"],
      description: "No marker here.",
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/no "Workflow-edit/);
  });

  it("fails closed when a marker is present but the label is missing", () => {
    const result = resolveWorkflowEditAuthorization({
      labels: [],
      description: "Workflow-edit: .github/workflows/ios-verify.yml",
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/isn't labeled/);
  });

  it("fails closed when more than one marker is declared", () => {
    const result = resolveWorkflowEditAuthorization({
      labels: ["ci:workflow-edit-authorized"],
      description: "Workflow-edit: .github/workflows/a.yml\nWorkflow-edit: .github/workflows/b.yml",
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/exactly one is required/);
  });

  it("fails closed when the declared path is not a single .github/workflows/*.yml file", () => {
    const result = resolveWorkflowEditAuthorization({
      labels: ["ci:workflow-edit-authorized"],
      description: "Workflow-edit: .github/workflows/**",
    });
    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/must be a single/);
  });

  it("fails closed on a path traversal attempt outside .github/workflows/", () => {
    const result = resolveWorkflowEditAuthorization({
      labels: ["ci:workflow-edit-authorized"],
      description: "Workflow-edit: .github/workflows/../../AGENTS.md",
    });
    expect(result.authorized).toBe(false);
  });
});

describe("evaluatePreflight — workflow-edit authorization", () => {
  it("does not block an ordinary issue with no workflow-edit attempt", () => {
    const result = evaluatePreflight({ labels: [], blockedByIds: [], description: "" }, baseContext());
    expect(result.ok).toBe(true);
  });

  it("passes a properly authorized issue through preflight", () => {
    const result = evaluatePreflight(
      {
        labels: ["ci:workflow-edit-authorized"],
        blockedByIds: [],
        description: "Workflow-edit: .github/workflows/ios-verify.yml",
      },
      baseContext(),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks a misconfigured workflow-edit attempt", () => {
    const result = evaluatePreflight(
      { labels: ["ci:workflow-edit-authorized"], blockedByIds: [], description: "" },
      baseContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/workflow-edit authorization misconfigured/);
  });
});
