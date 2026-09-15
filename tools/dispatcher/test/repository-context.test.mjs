import { describe, expect, it } from "vitest";
import { MAX_CHANGED_PATHS, MAX_RECENT_COMMITS, collectRepositoryContext } from "../src/repository-context.mjs";

describe("collectRepositoryContext", () => {
  it("collects bounded dispatcher-owned Git facts and redacts credential-shaped values", () => {
    const runner = (_command, args) => {
      if (args.join(" ") === "rev-parse HEAD") return "head-sha\n";
      if (args.join(" ") === "rev-parse origin/master") return "base-sha\n";
      if (args[0] === "status") return "";
      if (args[0] === "log") return ["abc first", "def token=super-secret"].join("\n");
      if (args[0] === "diff") return "src/app/page.tsx\n";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    expect(collectRepositoryContext({ worktreePath: "/tmp/wt", branch: "agent/MOV-1-fix", runner })).toEqual({
      branch: "agent/MOV-1-fix",
      headSha: "head-sha",
      baseRef: "origin/master",
      baseSha: "base-sha",
      clean: true,
      statusLines: [],
      recentCommits: ["abc first", "def token=[REDACTED]"],
      changedPaths: ["src/app/page.tsx"],
    });
  });

  it("bounds noisy status, log, and diff output without failing the worker setup", () => {
    const lines = Array.from({ length: MAX_CHANGED_PATHS + 5 }, (_, index) => `file-${index}`);
    const commits = Array.from({ length: MAX_RECENT_COMMITS + 5 }, (_, index) => `sha-${index} subject`);
    const runner = (_command, args) => {
      if (args[0] === "rev-parse") return "sha\n";
      if (args[0] === "status" || args[0] === "diff") return lines.join("\n");
      if (args[0] === "log") return commits.join("\n");
      return "";
    };
    const context = collectRepositoryContext({ worktreePath: "/tmp/wt", branch: "agent/MOV-1-fix", runner });
    expect(context.clean).toBe(false);
    expect(context.statusLines).toHaveLength(MAX_CHANGED_PATHS);
    expect(context.changedPaths).toHaveLength(MAX_CHANGED_PATHS);
    expect(context.recentCommits).toHaveLength(MAX_RECENT_COMMITS);
  });
});
