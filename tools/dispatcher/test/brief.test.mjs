import { describe, it, expect } from "vitest";
import { generateBrief } from "../src/brief.mjs";

describe("generateBrief", () => {
  const issue = {
    identifier: "MOV-42",
    title: "Fix the thing",
    url: "https://linear.app/moviecal/issue/MOV-42",
    description: "Do the specific fix described here.",
    labels: ["area:calendar", "risk:low"],
  };

  it("includes the issue identifier, title, and Linear URL", () => {
    const brief = generateBrief(issue, { branch: "agent/MOV-42-fix-the-thing", worktreePath: "/tmp/wt", worker: "claude", model: "default" });
    expect(brief).toContain("MOV-42: Fix the thing");
    expect(brief).toContain("https://linear.app/moviecal/issue/MOV-42");
  });

  it("includes the assigned branch and worktree path", () => {
    const brief = generateBrief(issue, { branch: "agent/MOV-42-fix-the-thing", worktreePath: "/tmp/wt", worker: "claude", model: "default" });
    expect(brief).toContain("agent/MOV-42-fix-the-thing");
    expect(brief).toContain("/tmp/wt");
  });

  it("includes the worker and model", () => {
    const brief = generateBrief(issue, { branch: "b", worktreePath: "/tmp/wt", worker: "codex", model: "strong" });
    expect(brief).toContain("codex");
    expect(brief).toContain("strong");
  });

  it("cites upgrade conditions when present", () => {
    const brief = generateBrief(issue, { branch: "b", worktreePath: "/tmp/wt", worker: "claude", model: "strong", upgradeConditions: ["architecture"] });
    expect(brief).toContain("architecture");
  });

  it("includes the issue description", () => {
    const brief = generateBrief(issue, { branch: "b", worktreePath: "/tmp/wt", worker: "claude", model: "default" });
    expect(brief).toContain("Do the specific fix described here.");
  });

  it("handles a missing description gracefully", () => {
    const brief = generateBrief({ ...issue, description: "" }, { branch: "b", worktreePath: "/tmp/wt", worker: "claude", model: "default" });
    expect(brief).toContain("no description provided");
  });

  it("includes labels when present", () => {
    const brief = generateBrief(issue, { branch: "b", worktreePath: "/tmp/wt", worker: "claude", model: "default" });
    expect(brief).toContain("area:calendar");
    expect(brief).toContain("risk:low");
  });

  it("references the required PR conventions (Test Impact, Linear reference, draft PR)", () => {
    const brief = generateBrief(issue, { branch: "b", worktreePath: "/tmp/wt", worker: "claude", model: "default" });
    expect(brief).toMatch(/draft/i);
    expect(brief).toContain("Test Impact");
    expect(brief).toContain("Linear: MOV-42");
  });

  it("tells the worker to stop and report rather than work around a hard deny", () => {
    const brief = generateBrief(issue, { branch: "b", worktreePath: "/tmp/wt", worker: "claude", model: "default" });
    expect(brief).toMatch(/stop and report/i);
  });
});
