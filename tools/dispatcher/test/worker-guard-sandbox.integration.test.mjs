// MOV-196: worker-guard.test.mjs asserts the generated Seatbelt profile
// *text* only -- it never actually applies the profile. That gap is exactly
// what missed MOV-193 (Codex denied a linked worktree's own Git metadata)
// and MOV-194 (the MOV-193 fix leaked sibling-worktree isolation): each was a
// real allow/deny outcome under sandbox-exec, not a string in the profile
// source. See the note at the bottom of this file for why a MOV-180/184
// nested-sandbox_apply reproduction is not included here.
//
// This suite builds a real multi-worktree Git fixture and actually invokes
// /usr/bin/sandbox-exec against it. CI's lane-integration job runs on
// ubuntu-latest, which has no Seatbelt, so this is a documented local-only
// gate (see docs/planning/testing-lanes.md): it skips cleanly rather than
// failing when sandbox-exec is unavailable. Run `npm run lane:integration`
// on macOS before sending a dispatcher sandbox change for review.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { buildWorkerSandboxProfile, guardedInvocation, repositoryGuardPaths } from "../src/worker-guard.mjs";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const sandboxAvailable = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);

describe.skipIf(!sandboxAvailable)("worker-guard sandbox-exec integration (MOV-196)", () => {
  let tmpDir;
  let mainDir;
  let ownDir;
  let siblingDir;
  let profilePath;

  beforeAll(() => {
    // Seatbelt matches resolved paths; os.tmpdir() on macOS is a symlink
    // (/var -> /private/var), so canonicalize before it ever reaches a
    // profile rule or the fixture would silently test the wrong path.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-sandbox-it-")));
    mainDir = path.join(tmpDir, "main");
    fs.mkdirSync(mainDir);

    const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git(mainDir, ["init", "-q"]);
    git(mainDir, ["config", "user.email", "test@example.com"]);
    git(mainDir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(mainDir, "main-file.txt"), "main content\n");
    git(mainDir, ["add", "."]);
    git(mainDir, ["commit", "-q", "-m", "init"]);

    ownDir = path.join(tmpDir, "own");
    siblingDir = path.join(tmpDir, "sibling");
    git(mainDir, ["worktree", "add", "-q", "-b", "own-branch", ownDir]);
    git(mainDir, ["worktree", "add", "-q", "-b", "sibling-branch", siblingDir]);

    fs.writeFileSync(path.join(ownDir, "own-secret.txt"), "own content\n");
    fs.writeFileSync(path.join(siblingDir, "sibling-secret.txt"), "sibling content\n");

    const { protectedRepositoryPaths, protectedRepositoryReadRules, gitMetadataPaths } =
      repositoryGuardPaths(ownDir);
    const profile = buildWorkerSandboxProfile({
      worktreePath: ownDir,
      home: path.join(tmpDir, "home"),
      mode: "implementation",
      protectedRepositoryPaths,
      protectedRepositoryReadRules,
      gitMetadataPaths,
    });
    profilePath = path.join(tmpDir, "worker-sandbox.sb");
    fs.writeFileSync(profilePath, profile);
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(command, args) {
    const invocation = guardedInvocation({ command, args }, { profilePath });
    return spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
  }

  it("allows reading a file inside the worker's own assigned worktree", () => {
    const result = run("/bin/cat", [path.join(ownDir, "own-secret.txt")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("own content");
  });

  it("allows reading the shared Git metadata the linked worktree depends on (MOV-193)", () => {
    const result = run("/bin/cat", [path.join(mainDir, ".git", "HEAD")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ref:");
  });

  it("denies reading a sibling worktree's working files (MOV-194)", () => {
    const result = run("/bin/cat", [path.join(siblingDir, "sibling-secret.txt")]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/operation not permitted|permission denied/i);
  });

  it("denies reading the main checkout's other working files even though its .git stays readable (MOV-194)", () => {
    const result = run("/bin/cat", [path.join(mainDir, "main-file.txt")]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/operation not permitted|permission denied/i);
  });

  it("succeeds for a single, non-nested invocation under the profile", () => {
    const result = run("/bin/echo", ["outer-ok"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("outer-ok");
  });

  // MOV-180/184 note: docs/operators/local-execution.md documents a
  // confirmed mechanism where nesting a second, independent sandbox_apply
  // call inside this deny-bearing profile crashes with `sandbox_apply:
  // Operation not permitted` (exit 71). This suite attempted to pin that as
  // a regression test by re-exec'ing /usr/bin/sandbox-exec inside itself
  // with the same profile, and it did NOT reproduce here (empirically
  // checked on this machine: two nested sandbox-exec CLI invocations with a
  // deny-rule-bearing profile both exit 0). Either the crash is specific to
  // however Claude Code's own internal sandbox applies itself in-process
  // (not via re-exec'ing the sandbox-exec binary, which is the only nesting
  // technique a test outside Claude Code itself can drive), or newer macOS
  // Seatbelt no longer exhibits the collision that was confirmed when
  // MOV-184 was investigated. Either way, asserting a crash here would be
  // asserting something false on this OS, so it is intentionally left out
  // rather than shipped as a misleading green check. The actual guarantee
  // that a real worker never re-triggers this hazard is enforced at the unit
  // level instead: worker-routing.test.mjs pins that Claude's invocation
  // always carries `--settings '{"sandbox":{"enabled":false}}'`, so the
  // second, independent sandbox_apply call this profile can't safely absorb
  // is never made in the first place.
});
