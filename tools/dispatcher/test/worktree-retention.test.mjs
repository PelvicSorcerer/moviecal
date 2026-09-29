import { describe, it, expect } from "vitest";
import {
  resolveIssueIdentity, evaluateTerminalState, parseStatusZ, isCredentialLikePath,
} from "../src/worktree-retention.mjs";
import { resolveWorktreeRetentionDays } from "../src/config.mjs";

const NOW = Date.parse("2026-09-29T00:00:00Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

describe("resolveIssueIdentity", () => {
  it("takes the issue from the directory name", () => {
    expect(resolveIssueIdentity({ worktreePath: "/w/MOV-331-seven-day", branch: null })).toMatchObject({ issueId: "MOV-331", source: "directory-name" });
  });
  it("falls back to an exact issue-scoped branch, then the registry record for that path", () => {
    expect(resolveIssueIdentity({ worktreePath: "/c/abcd/moviecal", branch: "agent/MOV-9-thing" })).toMatchObject({ issueId: "MOV-9", source: "branch" });
    expect(resolveIssueIdentity({ worktreePath: "/c/abcd/moviecal", branch: null, registryEntry: { id: "MOV-12" } })).toMatchObject({ issueId: "MOV-12", source: "registry" });
  });
  it("never guesses: no id, non-issue branches, several ids, or disagreeing sources are skipped", () => {
    expect(resolveIssueIdentity({ worktreePath: "/w/shared-plan", branch: "docs/MOV-5-plan" }).issueId).toBeNull();
    expect(resolveIssueIdentity({ worktreePath: "/w/MOV-1-and-MOV-2", branch: null })).toMatchObject({ issueId: null, ambiguous: true });
    expect(resolveIssueIdentity({ worktreePath: "/w/MOV-1-x", branch: "agent/MOV-2-y" })).toMatchObject({ issueId: null, ambiguous: true });
    expect(resolveIssueIdentity({ worktreePath: "/w/MOV-1-x", branch: null, registryEntry: { id: "MOV-3" } })).toMatchObject({ ambiguous: true });
  });
  it("does not match ids embedded in longer tokens", () => {
    expect(resolveIssueIdentity({ worktreePath: "/w/XMOV-5-a", branch: null }).issueId).toBeNull();
    expect(resolveIssueIdentity({ worktreePath: "/w/MOV-5x", branch: null }).issueId).toBe("MOV-5");
    expect(resolveIssueIdentity({ worktreePath: "/w/MOV-5", branch: null }).issueId).toBe("MOV-5");
  });
});

describe("evaluateTerminalState", () => {
  const done = (over = {}) => ({ identifier: "MOV-1", stateName: "Done", stateType: "completed", completedAt: iso(NOW - 8 * DAY), canceledAt: null, ...over });
  const ev = (snap, opts = {}) => evaluateTerminalState(snap, { expectedId: "MOV-1", now: NOW, ...opts });

  it("is eligible only after seven full days from the current terminal timestamp", () => {
    expect(ev(done())).toMatchObject({ verdict: "terminal", eligible: true, terminalAt: iso(NOW - 8 * DAY) });
    expect(ev(done({ completedAt: iso(NOW - 7 * DAY + 1) }))).toMatchObject({ verdict: "terminal", eligible: false });
    expect(ev(done({ completedAt: iso(NOW - 7 * DAY) })).eligible).toBe(true);
  });
  it("honours configured retention", () => {
    expect(ev(done(), { retentionDays: 14 })).toMatchObject({ eligible: false, eligibleAt: iso(NOW - 8 * DAY + 14 * DAY) });
  });
  it("handles Canceled with its own timestamp", () => {
    expect(ev({ identifier: "MOV-1", stateName: "Canceled", stateType: "canceled", completedAt: null, canceledAt: iso(NOW - 9 * DAY) }).eligible).toBe(true);
  });
  it("fails closed on active, mismatched, missing, future, or conflicting data", () => {
    expect(ev(done({ stateName: "In Progress", stateType: "started" })).verdict).toBe("active");
    expect(ev(done({ stateName: "Duplicate", stateType: "canceled" })).verdict).toBe("active");
    expect(ev(done({ stateType: "started" })).verdict).toBe("active");
    expect(ev(null).verdict).toBe("unknown");
    expect(ev(done({ identifier: "MOV-2" })).verdict).toBe("unknown");
    expect(ev(done({ completedAt: null })).verdict).toBe("unknown");
    expect(ev(done({ completedAt: "garbage" })).verdict).toBe("unknown");
    expect(ev(done({ completedAt: iso(NOW + DAY) })).verdict).toBe("unknown");
    expect(ev(done({ canceledAt: iso(NOW - DAY) })).verdict).toBe("unknown");
  });
});

describe("git status parsing and credential detection", () => {
  it("classifies staged, unstaged, untracked, ignored and unmerged entries", () => {
    const out = ["M  a.txt", " M b.txt", "?? c.txt", "!! node_modules/", "UU d.txt", "R  new.txt", "old.txt", ""].join("\0");
    const s = parseStatusZ(out);
    expect(s).toMatchObject({ staged: ["a.txt", "new.txt"], unstaged: ["b.txt"], untracked: ["c.txt"], ignored: ["node_modules/"], unmerged: ["d.txt"] });
  });
  it("flags credential-like paths but allows .env.example", () => {
    for (const p of [".env", ".env.local", "app/.env.production", "k.pem", "id_rsa", ".npmrc"]) expect(isCredentialLikePath(p)).toBe(true);
    for (const p of [".env.example", "src/env.ts", "README.md"]) expect(isCredentialLikePath(p)).toBe(false);
  });
});

describe("resolveWorktreeRetentionDays", () => {
  it("defaults to seven, accepts a flag or env, rejects nonsense", () => {
    delete process.env.MOVIECAL_WORKTREE_RETENTION_DAYS;
    expect(resolveWorktreeRetentionDays()).toBe(7);
    expect(resolveWorktreeRetentionDays("14")).toBe(14);
    process.env.MOVIECAL_WORKTREE_RETENTION_DAYS = "3";
    try { expect(resolveWorktreeRetentionDays()).toBe(3); expect(resolveWorktreeRetentionDays("10")).toBe(10); }
    finally { delete process.env.MOVIECAL_WORKTREE_RETENTION_DAYS; }
    for (const bad of ["0", "-1", "abc"]) expect(() => resolveWorktreeRetentionDays(bad)).toThrow();
  });
});
