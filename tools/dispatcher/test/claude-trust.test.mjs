import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trustWorkspace, isWorkspaceTrusted } from "../src/claude-trust.mjs";

describe("trustWorkspace / isWorkspaceTrusted", () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
  });

  it("fails cleanly when the config file doesn't exist", () => {
    const result = trustWorkspace("/some/worktree", "/nonexistent/.claude.json");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not exist/);
  });

  it("adds a new project entry with hasTrustDialogAccepted: true", () => {
    tmpFile = path.join(os.tmpdir(), `claude-trust-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ userID: "abc", projects: {} }));

    const result = trustWorkspace("/Users/adam/code/worktrees/moviecal/MOV-1-fix", tmpFile);

    expect(result.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    expect(written.userID).toBe("abc"); // untouched
    expect(written.projects["/Users/adam/code/worktrees/moviecal/MOV-1-fix"]).toEqual({
      hasTrustDialogAccepted: true,
    });
  });

  it("preserves every other key already on an existing project entry", () => {
    tmpFile = path.join(os.tmpdir(), `claude-trust-test-${Date.now()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        projects: {
          "/some/path": { allowedTools: ["Read"], hasTrustDialogAccepted: false, mcpContextUris: [] },
        },
      }),
    );

    trustWorkspace("/some/path", tmpFile);

    const written = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    expect(written.projects["/some/path"]).toEqual({
      allowedTools: ["Read"],
      hasTrustDialogAccepted: true,
      mcpContextUris: [],
    });
  });

  it("preserves every other project entry untouched", () => {
    tmpFile = path.join(os.tmpdir(), `claude-trust-test-${Date.now()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        projects: {
          "/other/project": { hasTrustDialogAccepted: false },
        },
      }),
    );

    trustWorkspace("/new/worktree", tmpFile);

    const written = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    expect(written.projects["/other/project"]).toEqual({ hasTrustDialogAccepted: false });
    expect(written.projects["/new/worktree"]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("fails cleanly on invalid JSON rather than throwing", () => {
    tmpFile = path.join(os.tmpdir(), `claude-trust-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, "{ not valid json");

    const result = trustWorkspace("/some/path", tmpFile);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed to parse/);
  });

  it("leaves no .tmp file behind on success", () => {
    tmpFile = path.join(os.tmpdir(), `claude-trust-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ projects: {} }));

    trustWorkspace("/some/path", tmpFile);

    const dir = path.dirname(tmpFile);
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(tmpFile) + ".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("isWorkspaceTrusted reflects what trustWorkspace wrote", () => {
    tmpFile = path.join(os.tmpdir(), `claude-trust-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ projects: {} }));

    expect(isWorkspaceTrusted("/a/path", tmpFile)).toBe(false);
    trustWorkspace("/a/path", tmpFile);
    expect(isWorkspaceTrusted("/a/path", tmpFile)).toBe(true);
  });

  it("isWorkspaceTrusted returns false rather than throwing when the file is missing", () => {
    expect(isWorkspaceTrusted("/a/path", "/nonexistent/.claude.json")).toBe(false);
  });
});
