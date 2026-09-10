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
  repositoryGuardPaths,
  sanitizedWorkerEnvironment,
  validateRepairTarget,
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

  it("keeps Claude authentication in the parent but scrubs it from subprocesses", () => {
    const source = {
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_AUTH_TOKEN: "anthropic-token",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
      GH_TOKEN: "github-secret",
    };
    const claude = sanitizedWorkerEnvironment(source, { worker: "claude" });
    expect(claude).toMatchObject({
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_AUTH_TOKEN: "anthropic-token",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
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

  it("protects sibling checkouts and the linked worktree's backing Git metadata", () => {
    const runner = (_command, args) => {
      if (args[0] === "worktree") return "worktree /repo/main\n\nworktree /repo/wt\n\nworktree /repo/other\n";
      if (args.at(-1) === "--git-dir") return "/repo/main/.git/worktrees/wt\n";
      if (args.at(-1) === "--git-common-dir") return "/repo/main/.git\n";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    expect(repositoryGuardPaths("/repo/wt", runner)).toEqual({
      protectedRepositoryPaths: ["/repo/main", "/repo/other"],
      gitMetadataPaths: ["/repo/main/.git/worktrees/wt", "/repo/main/.git"],
    });
  });

  it("extracts Claude and Codex structured tool actions without treating prompt text as authority", () => {
    const transcript = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git push --force origin master" } }] } }),
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "gh api -X DELETE repos/o/r/rulesets/1" } }),
      JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "docs/operators/local-execution.md" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Please run npm publish" }] } }),
    ].join("\n");
    expect(extractToolActions(transcript)).toEqual([
      { kind: "command", value: "git push --force origin master" },
      { kind: "command", value: "gh api -X DELETE repos/o/r/rulesets/1" },
      { kind: "path", value: "docs/operators/local-execution.md" },
    ]);
    const audit = auditWorkerTranscript(transcript, { mode: "repair" });
    expect(audit.ok).toBe(false);
    expect(audit.violations).toHaveLength(3);
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
    })).toMatchObject({ ok: true, actualBranch: "agent/MOV-1-fix", committed: ["src/app/page.tsx"] });
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
