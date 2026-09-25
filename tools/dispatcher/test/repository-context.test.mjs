import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_CHANGED_PATHS, MAX_RECENT_COMMITS, MAX_STARTING_POINTS, collectLikelyStartingPoints, collectRepositoryContext, issuePathCandidates } from "../src/repository-context.mjs";

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
      likelyStartingPoints: [],
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

describe("issue path orientation", () => {
  it("extracts backticked and bare paths without URLs or traversal", () => {
    expect(issuePathCandidates("Read `src/app/page.tsx`, then docs/operators/local-execution.md. Ignore https://example.com/a.ts and ../outside.ts.")).toEqual([
      "src/app/page.tsx", "docs/operators/local-execution.md",
    ]);
  });

  it("lists existing paths only, counts lines, marks large files, caps entries, and redacts path values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov365-orientation-"));
    try {
      fs.mkdirSync(path.join(root, "src"));
      for (let n = 0; n < MAX_STARTING_POINTS + 3; n++) {
        fs.writeFileSync(path.join(root, `src/file${n}.ts`), n === 0 ? "line\n".repeat(401) : "one\ntwo");
      }
      fs.writeFileSync(path.join(root, "src/token=secret.ts"), "secret file\n");
      const description = ["src/missing.ts", ...Array.from({ length: MAX_STARTING_POINTS + 3 }, (_, n) => `src/file${n}.ts`), "src/token=secret.ts"].join(" ");
      const points = collectLikelyStartingPoints({ worktreePath: root, description });
      expect(points).toHaveLength(MAX_STARTING_POINTS);
      expect(points[0]).toEqual({ path: "src/file0.ts", lines: 401, readByRange: true });
      expect(points[1]).toEqual({ path: "src/file1.ts", lines: 2, readByRange: false });
      expect(points.some((point) => point.path.includes("missing"))).toBe(false);
      expect(collectLikelyStartingPoints({ worktreePath: root, description: "src/token=secret.ts" })[0].path).toBe("src/token=[REDACTED]");
      expect(collectLikelyStartingPoints({ worktreePath: root, description: "No repository path here." })).toEqual([]);
      expect(collectLikelyStartingPoints({ worktreePath: root, description: "src/file0.ts", fsApi: { realpathSync: () => { throw new Error("unavailable"); } } })).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
