import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditChangedPaths,
  auditWorkerResult,
  auditWorkerTranscript,
  buildWorkerSandboxProfile,
  extractToolActions,
  guardedInvocation,
  isInsideWorkerSandboxEnv,
  repositoryGuardPaths,
  sanitizedWorkerEnvironment,
  validateRepairTarget,
  WORKER_SANDBOX_ENV_VAR,
  writeWorkerAudit,
} from "../src/worker-guard.mjs";

describe("worker guard", () => {
  let tmpDir;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips privileged credentials and disables interactive git auth", () => {
    const env = sanitizedWorkerEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      GH_TOKEN: "github-secret",
      LINEAR_API_KEY: "linear-secret",
      SUPABASE_SERVICE_ROLE_KEY: "db-secret",
      ORDINARY_FLAG: "yes",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/Users/test", ORDINARY_FLAG: "yes", GIT_TERMINAL_PROMPT: "0" });
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("LINEAR_API_KEY");
    expect(env).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
  });

  it("marks the sanitized environment as inside the worker sandbox (MOV-274 follow-up)", () => {
    const env = sanitizedWorkerEnvironment({ PATH: "/usr/bin" });
    expect(env[WORKER_SANDBOX_ENV_VAR]).toBe("1");
    expect(isInsideWorkerSandboxEnv(env)).toBe(true);
    expect(isInsideWorkerSandboxEnv({ PATH: "/usr/bin" })).toBe(false);
    expect(isInsideWorkerSandboxEnv({ [WORKER_SANDBOX_ENV_VAR]: "0" })).toBe(false);
  });

  it("keeps Claude worker authentication in the parent but excludes the dispatcher diagnosis key", () => {
    const source = {
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_AUTH_TOKEN: "anthropic-token",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
      GH_TOKEN: "github-secret",
    };
    const claude = sanitizedWorkerEnvironment(source, { worker: "claude" });
    expect(claude).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "anthropic-token",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(claude).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(claude).not.toHaveProperty("GH_TOKEN");

    const codex = sanitizedWorkerEnvironment(source, { worker: "codex" });
    expect(codex).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(codex).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(codex).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(codex).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
  });

  it("builds one inherited sandbox for both adapters with protected writes and credential reads denied", () => {
    const profile = buildWorkerSandboxProfile({
      worktreePath: "/tmp/worktree",
      home: "/Users/test",
      mode: "implementation",
    });
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/git"))');
    expect(profile).toContain('(deny process-exec (literal "/usr/local/bin/gh"))');
    // MOV-174: /usr/bin/security is intentionally NOT denied. Claude Code's own
    // startup credential probe (`security find-generic-password -s "Claude
    // Code..."`) always runs, regardless of ANTHROPIC_API_KEY/
    // CLAUDE_CODE_OAUTH_TOKEN, and a blanket exec deny crashed every worker
    // before it could do any work. A worker invoking `security` itself is
    // still caught by security-policy.mjs's post-hoc transcript audit.
    expect(profile).not.toContain('/usr/bin/security');
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/.config/gh"))');
    expect(profile).toContain('(deny file-write* (literal "/tmp/worktree/.git"))');
    expect(profile).toContain('(deny file-write* (subpath "/tmp/worktree/.github/workflows"))');
    expect(profile).not.toContain('/Users/test/.config/moviecal/env.local');
    expect(profile).not.toContain("/tmp/worktree/test");

    const repair = buildWorkerSandboxProfile({ worktreePath: "/tmp/worktree", home: "/Users/test", mode: "repair" });
    expect(repair).toContain('(deny file-write* (subpath "/tmp/worktree/test"))');
    expect(repair).toContain('(deny file-write* (subpath "/tmp/worktree/tools/dispatcher"))');
    expect(repair).toContain('(deny file-read* (subpath "/Users/test/.config/moviecal/env.local"))');
  });

  it("wraps Claude and Codex identically at the process boundary", () => {
    const profilePath = "/tmp/run/worker-sandbox.sb";
    expect(guardedInvocation({ command: "claude", args: ["-p"] }, { profilePath })).toEqual({
      command: "/usr/bin/sandbox-exec",
      args: ["-f", profilePath, "claude", "-p"],
    });
    expect(guardedInvocation({ command: "codex", args: ["exec"] }, { profilePath }).command).toBe("/usr/bin/sandbox-exec");
  });

  it("keeps sibling source denied while exposing a linked worktree's backing Git metadata (MOV-204: real checkouts carry the documented .env.local symlink, not a plain file)", () => {
    const runner = (_command, args) => {
      if (args[0] === "worktree") return "worktree /repo/main\n\nworktree /repo/wt\n\nworktree /repo/other\n";
      if (args.at(-1) === "--git-dir") return "/repo/main/.git/worktrees/wt\n";
      if (args.at(-1) === "--git-common-dir") return "/repo/main/.git\n";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const fsImpl = {
      readdirSync: (target) => {
        expect(target).toBe("/repo/main");
        return [
          { name: ".git", isDirectory: () => true, isSymbolicLink: () => false },
          { name: "src", isDirectory: () => true, isSymbolicLink: () => false },
          { name: ".env.local", isDirectory: () => false, isSymbolicLink: () => true },
        ];
      },
      readlinkSync: (target) => {
        expect(target).toBe("/repo/main/.env.local");
        return "/Users/test/.config/moviecal/env.local";
      },
    };
    expect(repositoryGuardPaths("/repo/wt", runner, fsImpl, "/Users/test")).toEqual({
      protectedRepositoryPaths: ["/repo/main", "/repo/other"],
      protectedRepositoryReadRules: [
        ["subpath", "/repo/main/src"],
        ["literal", "/repo/main/.env.local"],
        ["subpath", "/repo/other"],
      ],
      gitMetadataPaths: ["/repo/main/.git/worktrees/wt", "/repo/main/.git"],
    });
  });

  describe("MOV-204: the documented .env.local symlink is the one entry a protected checkout is permitted to have", () => {
    const runner = (_command, args) => {
      if (args[0] === "worktree") return "worktree /repo/main\n\nworktree /repo/wt\n";
      if (args.at(-1) === "--git-dir") return "/repo/main/.git/worktrees/wt\n";
      if (args.at(-1) === "--git-common-dir") return "/repo/main/.git\n";
      throw new Error(`unexpected ${args.join(" ")}`);
    };

    it("rejects a .env.local that is a symlink to the wrong target", () => {
      expect(() => repositoryGuardPaths("/repo/wt", runner, {
        readdirSync: () => [
          { name: ".git", isDirectory: () => true, isSymbolicLink: () => false },
          { name: ".env.local", isDirectory: () => false, isSymbolicLink: () => true },
        ],
        readlinkSync: () => "/Users/test/.config/moviecal/some-other-file",
      }, "/Users/test")).toThrow(/contains a symbolic link \(\.env\.local\)/);
    });

    it("rejects a .env.local symlink whose target cannot be resolved", () => {
      expect(() => repositoryGuardPaths("/repo/wt", runner, {
        readdirSync: () => [
          { name: ".git", isDirectory: () => true, isSymbolicLink: () => false },
          { name: ".env.local", isDirectory: () => false, isSymbolicLink: () => true },
        ],
        readlinkSync: () => { throw new Error("EINVAL"); },
      }, "/Users/test")).toThrow(/contains a symbolic link \(\.env\.local\)/);
    });

    it("rejects a differently-named symlink even when it points at the documented env.local target", () => {
      expect(() => repositoryGuardPaths("/repo/wt", runner, {
        readdirSync: () => [
          { name: ".git", isDirectory: () => true, isSymbolicLink: () => false },
          { name: "leak", isDirectory: () => false, isSymbolicLink: () => true },
        ],
        readlinkSync: () => "/Users/test/.config/moviecal/env.local",
      }, "/Users/test")).toThrow(/contains a symbolic link \(leak\)/);
    });

    it("still fails closed when the checkout is unreadable, independent of the symlink carve-out", () => {
      expect(() => repositoryGuardPaths("/repo/wt", runner, {
        readdirSync: () => { throw new Error("EACCES"); },
      })).toThrow(/could not inspect protected checkout/);
    });
  });

  it("does not let a broad sibling-read denial override linked Git metadata", () => {
    const profile = buildWorkerSandboxProfile({
      worktreePath: "/repo/wt",
      home: "/Users/test",
      protectedRepositoryPaths: ["/repo/main", "/repo/other"],
      protectedRepositoryReadRules: [
        ["subpath", "/repo/main/src"],
        ["literal", "/repo/main/.env.local"],
        ["subpath", "/repo/other"],
      ],
      gitMetadataPaths: ["/repo/main/.git/worktrees/wt", "/repo/main/.git"],
    });
    expect(profile).not.toContain('(deny file-read* (subpath "/repo/main"))');
    expect(profile).toContain('(deny file-read* (subpath "/repo/main/src"))');
    expect(profile).toContain('(deny file-read* (literal "/repo/main/.env.local"))');
    expect(profile).toContain('(deny file-write* (subpath "/repo/main"))');
    expect(profile).toContain('(deny file-write* (subpath "/repo/main/.git"))');
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/git"))');
  });

  it("does not restore a broad sibling-read denial when a metadata-owning checkout has only .git", () => {
    const profile = buildWorkerSandboxProfile({
      worktreePath: "/repo/wt",
      home: "/Users/test",
      protectedRepositoryPaths: ["/repo/main"],
      protectedRepositoryReadRules: [],
      gitMetadataPaths: ["/repo/main/.git/worktrees/wt", "/repo/main/.git"],
    });
    expect(profile).not.toContain('(deny file-read* (subpath "/repo/main"))');
    expect(profile).toContain('(deny file-write* (subpath "/repo/main"))');
  });

  it("fails closed when a linked worktree points its Git directory outside the common Git directory", () => {
    const runner = (_command, args) => {
      if (args[0] === "worktree") return "worktree /repo/main\n\nworktree /repo/wt\n";
      if (args.at(-1) === "--git-dir") return "/outside/.git/worktrees/wt\n";
      if (args.at(-1) === "--git-common-dir") return "/repo/main/.git\n";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    expect(() => repositoryGuardPaths("/repo/wt", runner)).toThrow(/escapes its common Git directory/);
  });

  it("fails closed when Git returns an empty metadata path", () => {
    const runner = (_command, args) => {
      if (args[0] === "worktree") return "worktree /repo/wt\n";
      return "\n";
    };
    expect(() => repositoryGuardPaths("/repo/wt", runner)).toThrow(/metadata paths are empty/);
  });

  it("extracts Claude and Codex structured tool actions with their execution outcome", () => {
    const transcript = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git push --force origin master" } }] } }),
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "gh api -X DELETE repos/o/r/rulesets/1" } }),
      JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "docs/operators/local-execution.md" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Please run npm publish" }] } }),
    ].join("\n");
    expect(extractToolActions(transcript)).toEqual([
      { kind: "command", value: "git push --force origin master", outcome: "unknown" },
      { kind: "command", value: "gh api -X DELETE repos/o/r/rulesets/1", outcome: "unknown" },
      { kind: "path", value: "docs/operators/local-execution.md", outcome: "executed" },
    ]);
    const audit = auditWorkerTranscript(transcript, { mode: "repair" });
    expect(audit.ok).toBe(false);
    expect(audit.violations).toHaveLength(3);
  });

  it("keeps a harness-denied scope command as a warning, not a publication blocker", () => {
    const transcript = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "git status --short" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "Permission to use Bash with command git status --short has been denied." }] } }),
    ].join("\n");
    expect(extractToolActions(transcript)).toEqual([{ kind: "command", value: "git status --short", outcome: "denied" }]);
    expect(auditWorkerTranscript(transcript)).toMatchObject({
      ok: true,
      warnings: [{ reason: "all Git operations are dispatcher-only", category: "scope", outcome: "denied" }],
      violations: [],
    });
  });

  it("fails closed for executed or unknown scope commands and every safety attempt", () => {
    const executedScope = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "git status", exit_code: 0 } });
    const unknownScope = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "git status" } });
    const deniedSafety = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-2", name: "Bash", input: { command: "security dump-keychain" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-2", is_error: true, content: "Permission denied" }] } }),
    ].join("\n");
    for (const transcript of [executedScope, unknownScope, deniedSafety]) {
      expect(auditWorkerTranscript(transcript)).toMatchObject({ ok: false, warnings: [] });
    }
  });

  it("blocks protected diffs even if a tool transcript hid the write construction", () => {
    expect(auditChangedPaths(["src/app/page.tsx"], { mode: "repair" }).ok).toBe(true);
    expect(auditChangedPaths(["test/page.test.ts", ".github/workflows/verify.yml"], { mode: "repair" })).toMatchObject({
      ok: false,
      violations: [{ action: "test/page.test.ts" }, { action: ".github/workflows/verify.yml" }],
    });
  });

  it("fails closed on empty or malformed structured output", () => {
    expect(auditWorkerTranscript("", { mode: "repair" })).toMatchObject({
      ok: false,
      violations: [{ reason: "structured worker transcript is empty" }],
    });
    expect(auditWorkerTranscript("not-json\n", { mode: "repair" })).toMatchObject({
      ok: false,
      violations: [{ reason: "malformed structured worker event" }],
    });
  });

  it("audits branch identity, base/dirty paths, and transcript together", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-guard-"));
    fs.writeFileSync(path.join(tmpDir, "stdout.log"), JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "npm run verify" },
    }) + "\n");
    const runner = (_command, args) => {
      if (args[0] === "branch") return "agent/MOV-1-fix\n";
      if (args[0] === "diff") return "src/app/page.tsx\n";
      if (args[0] === "status") return "";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    expect(auditWorkerResult({
      worktreePath: "/tmp/wt",
      branch: "agent/MOV-1-fix",
      logDir: tmpDir,
      mode: "implementation",
      runner,
    })).toMatchObject({
      ok: true,
      actualBranch: "agent/MOV-1-fix",
      committed: ["src/app/page.tsx"],
      actions: [{ kind: "command", value: "npm run verify", outcome: "unknown" }],
    });
  });

  it("writes a checksummed audit record outside the worktree", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-audit-"));
    const record = writeWorkerAudit(tmpDir, { issue: "MOV-1", ok: false, violations: [{ reason: "blocked" }] }, {
      now: () => new Date("2026-09-10T00:00:00Z"),
    });
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(fs.readFileSync(record.path, "utf8"))).toMatchObject({ issue: "MOV-1", ok: false, sha256: record.sha256 });
  });

  it("admits only same-repository PRs on dispatcher-provenanced retained branches", () => {
    const entry = {
      id: "MOV-1",
      status: "review",
      branch: "agent/MOV-1-fix",
      headSha: "abc",
      provenance: { executor: "moviecal-dispatcher", repository: "owner/repo" },
    };
    const observation = { headRepository: "owner/repo", headBranch: "agent/MOV-1-fix", headSha: "abc" };
    expect(validateRepairTarget({ entry, observation, repository: "owner/repo" })).toEqual({ ok: true, reasons: [] });
    expect(validateRepairTarget({
      entry,
      observation: { ...observation, headRepository: "attacker/fork" },
      repository: "owner/repo",
    })).toMatchObject({ ok: false, reasons: expect.arrayContaining(["fork PRs are not eligible for repair"]) });
    expect(validateRepairTarget({
      entry: { ...entry, provenance: undefined },
      observation,
      repository: "owner/repo",
    }).ok).toBe(false);
    expect(validateRepairTarget({
      entry,
      observation: { ...observation, headBranch: "unknown-branch" },
      repository: "owner/repo",
    }).ok).toBe(false);
  });
});
