import { describe, it, expect } from "vitest";
import path from "node:path";
import { applyStagedWorkflowEdit } from "../src/workflow-edit-apply.mjs";

function fakeFs(files) {
  const store = new Map(Object.entries(files));
  return {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => {
      if (!store.has(p)) throw new Error(`ENOENT: ${p}`);
      return store.get(p);
    },
    writeFileSync: (p, content) => store.set(p, content),
    mkdirSync: () => {},
    _store: store,
  };
}

describe("applyStagedWorkflowEdit", () => {
  it("reports not-applied when no staged proposal exists", () => {
    const fsImpl = fakeFs({});
    const calls = [];
    const runner = (cmd, args) => calls.push({ cmd, args });

    const result = applyStagedWorkflowEdit("/repo/worktree", ".github/workflows/ios-verify.yml", {
      fsImpl,
      runner,
    });

    expect(result).toEqual({ applied: false, reason: "no staged proposal found" });
    expect(calls).toEqual([]);
  });

  it("writes the staged content into place and commits+pushes when a proposal exists", () => {
    const stagedPath = path.join(
      "/repo/worktree",
      "tools",
      "dispatcher",
      "pending-workflow-edits",
      "ios-verify.yml",
    );
    const fsImpl = fakeFs({ [stagedPath]: "name: ios-verify\non: [pull_request]\n" });
    const calls = [];
    const runner = (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return "";
    };

    const result = applyStagedWorkflowEdit("/repo/worktree", ".github/workflows/ios-verify.yml", {
      fsImpl,
      runner,
    });

    expect(result).toEqual({ applied: true, path: ".github/workflows/ios-verify.yml" });

    const targetPath = path.join("/repo/worktree", ".github/workflows/ios-verify.yml");
    expect(fsImpl._store.get(targetPath)).toBe("name: ios-verify\non: [pull_request]\n");

    expect(calls[0]).toMatchObject({ cmd: "git", cwd: "/repo/worktree" });
    expect(calls[0].args).toContain("rm");
    expect(calls[1].args).toEqual(["add", ".github/workflows/ios-verify.yml"]);
    expect(calls[2].args[0]).toBe("commit");
    expect(calls[3].args).toEqual(["push"]);
    for (const c of calls) expect(c.cwd).toBe("/repo/worktree");
  });
});
