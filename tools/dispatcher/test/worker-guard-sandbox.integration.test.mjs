// MOV-196: worker-guard.test.mjs asserts the generated Seatbelt profile
// *text* only -- it never actually applies the profile. That gap is exactly
// what missed MOV-193 (Codex denied a linked worktree's own Git metadata)
// and MOV-194 (the MOV-193 fix leaked sibling-worktree isolation): each was a
// real allow/deny outcome under sandbox-exec, not a string in the profile
// source. The installed Codex path is additionally covered in
// codex-containment.integration.test.mjs (MOV-401).
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
import { buildWorkerSandboxProfile, guardedInvocation, repositoryGuardPaths, isInsideWorkerSandboxEnv } from "../src/worker-guard.mjs";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// This suite's own beforeAll() drives a real `git` binary to build its
// multi-worktree fixture, before any of its nested sandbox-exec assertions
// even run. When `npm run verify` itself runs as a dispatcher worker, the
// *outer* Seatbelt profile worker-guard.mjs already applied to that worker
// denies `git` process-exec outright, so that fixture setup fails closed on
// a sandbox denial that has nothing to do with what this suite checks. It
// keeps running at full strength for a human/local `npm run verify` on a
// Mac outside the worker sandbox, which is the only place it ever provided
// real coverage (CI's lane-integration job has no Seatbelt at all) (MOV-274
// follow-up).
const sandboxAvailable = process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC) && !isInsideWorkerSandboxEnv();

describe.skipIf(!sandboxAvailable)("worker-guard sandbox-exec integration (MOV-196)", () => {
  let tmpDir;
  let mainDir;
  let ownDir;
  let siblingDir;
  let profilePath;
  let repairProfilePath;
  let homeDir;
  let envLocalTarget;

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

    // MOV-204: every real checkout -- the main checkout included -- carries
    // the documented `.env.local -> <home>/.config/moviecal/env.local`
    // symlink. `WorktreeManager.create()` symlinks the same target into
    // every dispatcher-created worktree too, so the worker's own worktree
    // gets one exactly like this.
    homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(path.join(homeDir, ".config", "moviecal"), { recursive: true });
    envLocalTarget = path.join(homeDir, ".config", "moviecal", "env.local");
    fs.writeFileSync(envLocalTarget, "DISPOSABLE_DEV_SECRET=not-a-real-credential\n");
    fs.symlinkSync(envLocalTarget, path.join(mainDir, ".env.local"));
    fs.symlinkSync(envLocalTarget, path.join(ownDir, ".env.local"));

    const { protectedRepositoryPaths, protectedRepositoryReadRules, gitMetadataPaths } =
      repositoryGuardPaths(ownDir, undefined, undefined, homeDir);
    const profile = buildWorkerSandboxProfile({
      worktreePath: ownDir,
      home: homeDir,
      mode: "implementation",
      protectedRepositoryPaths,
      protectedRepositoryReadRules,
      gitMetadataPaths,
    });
    profilePath = path.join(tmpDir, "worker-sandbox.sb");
    fs.writeFileSync(profilePath, profile);

    const repairProfile = buildWorkerSandboxProfile({
      worktreePath: ownDir,
      home: homeDir,
      mode: "repair",
      protectedRepositoryPaths,
      protectedRepositoryReadRules,
      gitMetadataPaths,
    });
    repairProfilePath = path.join(tmpDir, "worker-sandbox-repair.sb");
    fs.writeFileSync(repairProfilePath, repairProfile);
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(command, args, profile = profilePath) {
    const invocation = guardedInvocation({ command, args }, { profilePath: profile });
    return spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
  }

  it("builds a profile at all without throwing when the main checkout carries the documented .env.local symlink (MOV-204)", () => {
    // The whole point of this fixture: beforeAll() above calls
    // repositoryGuardPaths(ownDir) with a main checkout that has a
    // `.env.local` symlink in it, exactly like every real checkout on this
    // machine. Before MOV-204 that threw ("contains a symbolic link
    // (.env.local)") before a worker could ever start -- reaching this test
    // at all is the regression check.
    expect(fs.readFileSync(profilePath, "utf8")).toContain("(version 1)");
  });

  it("denies reading the main checkout's .env.local symlink and its resolved target (MOV-204)", () => {
    const viaSymlink = run("/bin/cat", [path.join(mainDir, ".env.local")]);
    expect(viaSymlink.status).not.toBe(0);
    expect(`${viaSymlink.stdout}${viaSymlink.stderr}`).toMatch(/operation not permitted|permission denied/i);
  });

  it("still allows reading the worker's own worktree's .env.local in implementation mode (unchanged, disposable dev credentials)", () => {
    const result = run("/bin/cat", [path.join(ownDir, ".env.local")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DISPOSABLE_DEV_SECRET");
  });

  it("denies reading the worker's own worktree's .env.local in repair mode (pre-existing, unaffected by MOV-204)", () => {
    const result = run("/bin/cat", [path.join(ownDir, ".env.local")], repairProfilePath);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/operation not permitted|permission denied/i);
  });

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

  // Installed Codex nesting, native tool execution and replacement
  // containment are covered by codex-containment.integration.test.mjs.
});
