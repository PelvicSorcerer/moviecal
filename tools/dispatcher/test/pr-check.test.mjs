import { describe, it, expect } from "vitest";
import { findPrForBranch } from "../src/pr-check.mjs";

describe("findPrForBranch", () => {
  it("returns null when gh finds no matching PR", () => {
    const runner = () => "[]";
    expect(findPrForBranch("agent/MOV-1-fix", "owner/repo", runner)).toBeNull();
  });

  it("returns the PR details when one is found", () => {
    const runner = (cmd, args) => {
      expect(cmd).toBe("gh");
      expect(args).toEqual([
        "pr",
        "list",
        "--repo",
        "owner/repo",
        "--head",
        "agent/MOV-1-fix",
        "--json",
        "number,url,isDraft",
        "--limit",
        "1",
      ]);
      return JSON.stringify([{ number: 42, url: "https://github.com/owner/repo/pull/42", isDraft: true }]);
    };

    expect(findPrForBranch("agent/MOV-1-fix", "owner/repo", runner)).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      isDraft: true,
    });
  });
});
