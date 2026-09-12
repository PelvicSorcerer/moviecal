import { describe, expect, it } from "vitest";
import { publishRepairResult, publishWorkerResult, pullRequestBody } from "../src/worker-publish.mjs";

const ISSUE = { identifier: "MOV-42", title: "Fix the thing" };

function runnerFixture({ branch = "agent/MOV-42-fix-the-thing", dirty = " M src/app/page.tsx\n", staged = "src/app/page.tsx\n", ahead = "1", existingPr = null } = {}) {
  const calls = [];
  let created = false;
  let committed = false;
  const runner = (command, args, opts) => {
    calls.push({ command, args, opts });
    if (command === "git" && args[0] === "branch") return `${branch}\n`;
    if (command === "git" && args[0] === "status") return committed ? "" : dirty;
    if (command === "git" && args[0] === "add") return "";
    if (command === "git" && args[0] === "diff") return staged;
    if (command === "git" && args[0] === "commit") {
      committed = true;
      return "";
    }
    if (command === "git" && args[0] === "rev-list") return `${ahead}\n`;
    if (command === "git" && args[0] === "push") return "";
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      const pr = existingPr || (created ? { number: 9, url: "https://github.com/o/r/pull/9", isDraft: true, headRefOid: "abc" } : null);
      return JSON.stringify(pr ? [pr] : []);
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      created = true;
      return "https://github.com/o/r/pull/9\n";
    }
    throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
  };
  return { runner, calls };
}

describe("trusted worker publication", () => {
  it("commits audited changes, pushes only the exact assigned branch without force, and creates one draft PR", () => {
    const { runner, calls } = runnerFixture();
    const result = publishWorkerResult({
      worktreePath: "/tmp/wt",
      branch: "agent/MOV-42-fix-the-thing",
      repo: "owner/repo",
      issue: ISSUE,
      runner,
    });
    expect(result).toMatchObject({ number: 9, isDraft: true, headSha: "abc" });
    expect(calls.find((call) => call.command === "git" && call.args[0] === "add")?.args).toEqual(["add", "--all"]);
    expect(calls.find((call) => call.command === "git" && call.args[0] === "commit")?.args).toEqual([
      "commit",
      "-m",
      "fix: MOV-42 Fix the thing",
    ]);
    const push = calls.find((call) => call.command === "git" && call.args[0] === "push");
    expect(push.args).toEqual(["push", "--set-upstream", "origin", "HEAD:refs/heads/agent/MOV-42-fix-the-thing"]);
    expect(push.args.join(" ")).not.toMatch(/force/);
    const create = calls.find((call) => call.command === "gh" && call.args[1] === "create");
    expect(create.args).toContain("--draft");
    expect(create.args.at(create.args.indexOf("--body") + 1)).toContain("Fixes MOV-42");
  });

  it("reuses an existing PR instead of creating a replacement", () => {
    const { runner, calls } = runnerFixture({ existingPr: { number: 7, url: "url", isDraft: false, headRefOid: "def" } });
    expect(publishWorkerResult({
      worktreePath: "/tmp/wt",
      branch: "agent/MOV-42-fix-the-thing",
      repo: "owner/repo",
      issue: ISSUE,
      runner,
    })).toMatchObject({ number: 7, headSha: "def" });
    expect(calls.some((call) => call.command === "gh" && call.args[1] === "create")).toBe(false);
  });

  it.each([
    ["wrong branch", { branch: "master" }, /expected/],
    ["no filesystem changes", { dirty: "" }, /no audited filesystem changes/],
    ["empty Git index", { staged: "" }, /empty Git index/],
    ["no dispatcher commit", { ahead: "0" }, /no commit/],
  ])("fails closed for %s", (_label, fixture, expected) => {
    const { runner, calls } = runnerFixture(fixture);
    expect(() => publishWorkerResult({
      worktreePath: "/tmp/wt",
      branch: "agent/MOV-42-fix-the-thing",
      repo: "owner/repo",
      issue: ISSUE,
      runner,
    })).toThrow(expected);
    expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
  });

  it("rejects an unknown branch namespace before executing anything", () => {
    const { runner, calls } = runnerFixture();
    expect(() => publishWorkerResult({ worktreePath: "/tmp/wt", branch: "feature/x", repo: "owner/repo", issue: ISSUE, runner })).toThrow(/namespace/);
    expect(calls).toEqual([]);
  });

  it("keeps required PR governance fields in the dispatcher-authored body", () => {
    const body = pullRequestBody(ISSUE);
    expect(body).toContain("## Test Impact");
    expect(body).toContain("Linear: MOV-42");
    expect(body).toContain("Fixes MOV-42");
  });
});

describe("publishRepairResult", () => {
  function repairRunner({ head = "abc123", pr = { number: 42, url: "https://github.test/pr/42" } } = {}) {
    const calls = [];
    const runner = (command, args) => {
      calls.push([command, args]);
      const joined = args.join(" ");
      if (joined === "branch --show-current") return "agent/MOV-149-repair-ci\n";
      if (joined === "rev-parse HEAD") return `${head}\n`;
      if (joined === "status --porcelain=v1") return calls.filter(([, a]) => a[0] === "commit").length ? "" : " M src/app/page.tsx\n";
      if (joined === "diff --cached --name-only") return "src/app/page.tsx\n";
      if (command === "gh" && args[0] === "pr" && args[1] === "list") return JSON.stringify(pr ? [pr] : []);
      return "";
    };
    return { runner, calls };
  }

  it("commits and non-force pushes a repair to the original PR", () => {
    const { runner, calls } = repairRunner();
    const result = publishRepairResult({
      worktreePath: "/tmp/repair",
      branch: "agent/MOV-149-repair-ci",
      repo: "owner/repo",
      issue: { identifier: "MOV-149" },
      expectedHeadSha: "abc123",
      runner,
    });
    expect(result.number).toBe(42);
    expect(calls).toContainEqual(["git", ["push", "origin", "HEAD:refs/heads/agent/MOV-149-repair-ci"]]);
    expect(calls.some(([command, args]) => command === "gh" && args.includes("create"))).toBe(false);
    expect(calls.flatMap(([, args]) => args).some((arg) => String(arg).includes("force"))).toBe(false);
  });

  it("fails closed before staging when the observed SHA is stale", () => {
    const { runner, calls } = repairRunner({ head: "changed" });
    expect(() => publishRepairResult({
      worktreePath: "/tmp/repair",
      branch: "agent/MOV-149-repair-ci",
      repo: "owner/repo",
      issue: { identifier: "MOV-149" },
      expectedHeadSha: "abc123",
      runner,
    })).toThrow(/target moved/);
    expect(calls.some(([, args]) => args[0] === "add")).toBe(false);
  });

  it("refuses to repair a branch without an existing PR", () => {
    const { runner } = repairRunner({ pr: null });
    expect(() => publishRepairResult({
      worktreePath: "/tmp/repair",
      branch: "agent/MOV-149-repair-ci",
      repo: "owner/repo",
      issue: { identifier: "MOV-149" },
      expectedHeadSha: "abc123",
      runner,
    })).toThrow(/no existing PR/);
  });
});
