// MOV-198: worktree-manager.test.mjs has strong coverage of the *state-file*
// reclaim logic (MOV-181/185) -- which entry is reclaimable, when a dirty
// worktree blocks it -- but every one of those tests runs against a fake
// `runner`, single-process and synchronous. None of them exercise what
// happens when a real second process is genuinely still touching the
// worktree directory while a reclaim runs, or when the directory's on-disk
// content stops matching what the state registry believes about it (this
// session's own worktree was emptied out from under it mid-task while
// preparing this issue -- see docs/operators/local-execution.md).
//
// This suite uses the real `defaultRunner` (real git, real filesystem) under
// a temp directory with a real origin remote, so `git worktree remove
// --force`'s actual behavior -- not a fake standing in for it -- is what
// gets exercised. CI's lane-integration job runs on ubuntu-latest; nothing
// here is macOS-specific (unlike worker-guard-sandbox.integration.test.mjs),
// but it does real subprocess/filesystem work, so it belongs in this lane
// per docs/planning/testing-lanes.md, not lane:unit.
//
// The first `it.fails(...)` case below remains a genuine,
// empirically-confirmed gap, not an aspirational spec. It is written as the
// property the code *should* have; today's implementation does not have it,
// so the test body's own assertion fails, and `it.fails` reports that failure
// as this test passing. If the underlying gap is fixed, the assertion will
// start succeeding, `it.fails` will report that as an unexpected pass, and CI
// will fail as the signal to convert it back into an ordinary `it`. MOV-202
// fixes the second case: startup reconciliation now verifies the recorded
// path is still an intact linked Git worktree. See
// docs/operators/local-execution.md §Worktree lifecycle.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { WorktreeManager, defaultRunner } from "../src/worktree-manager.mjs";
import { isInsideWorkerSandboxEnv } from "../src/worker-guard.mjs";

// Real `git` fixtures, same constraint as startup-recovery.integration.test.mjs:
// under a dispatcher worker's own Seatbelt sandbox, `git` process-exec is
// denied to the worker and every child it spawns (including `npm run verify`
// -> vitest -> this file), so this suite cannot run there without hitting a
// sandbox denial unrelated to worktree-reclaim behavior. Full coverage stays
// in CI (ubuntu-latest, no sandbox involved) and any human/local run of
// `npm run verify` outside the worker sandbox (MOV-274 follow-up).
const insideWorkerSandbox = isInsideWorkerSandboxEnv();

const ISSUE_ID = "MOV-TEST";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A real main checkout + a real (local, bare) origin remote, so
 * `hasUnpushedCommits()`'s `origin/<branch>`/`origin/master` comparison has
 * a genuine remote-tracking ref to compare against, exactly like a real
 * dispatcher-owned checkout.
 */
function buildRepoFixture(tmpRoot) {
  const mainDir = path.join(tmpRoot, "main");
  fs.mkdirSync(mainDir);
  git(mainDir, ["init", "-q", "-b", "master"]);
  git(mainDir, ["config", "user.email", "test@example.com"]);
  git(mainDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(mainDir, "README.md"), "fixture\n");
  git(mainDir, ["add", "."]);
  git(mainDir, ["commit", "-q", "-m", "init"]);

  const originDir = path.join(tmpRoot, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", mainDir, originDir], { encoding: "utf8" });
  git(mainDir, ["remote", "add", "origin", originDir]);
  git(mainDir, ["push", "-q", "-u", "origin", "master"]);

  return { mainDir };
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

describe.skipIf(insideWorkerSandbox)("worktree reclaim under real concurrent access (MOV-198)", () => {
  let tmpRoot;
  let mainDir;
  let worktreeRoot;
  let statePath;

  beforeAll(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-reclaim-it-")));
    ({ mainDir } = buildRepoFixture(tmpRoot));
    worktreeRoot = path.join(tmpRoot, "worktrees");
    statePath = path.join(tmpRoot, "worktrees.json");
  });

  afterAll(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it(
    "refuses reclaim rather than silently destroying a real concurrent process's in-progress write",
    () => {
      const worktreePath = path.join(worktreeRoot, "race-worktree");
      git(mainDir, ["worktree", "add", "-q", worktreePath, "-b", "agent/MOV-TEST-race", "origin/master"]);
      writeState(statePath, {
        [ISSUE_ID]: { id: ISSUE_ID, path: worktreePath, branch: "agent/MOV-TEST-race", status: "failed" },
      });

      const concurrentFile = path.join(worktreePath, "still-being-written.txt");

      // isPathFreeForIssue()'s reclaim path is: check clean (git status),
      // then -- as a *separate* subsequent git invocation -- actually
      // remove the worktree with --force. Nothing holds a lock across that
      // gap. Rather than hope a real race lands in that window (flaky), the
      // injectable `runner` this module was already built for testing hooks
      // the exact boundary: right after the real `git status --porcelain`
      // call returns "clean" for this worktree, a genuinely separate OS
      // process (not just an in-process async call) writes a new file into
      // it, deterministically landing the write in the TOCTOU gap on every
      // run.
      let injected = false;
      const racingRunner = (command, args, opts) => {
        const result = defaultRunner(command, args, opts);
        if (!injected && command === "git" && args[0] === "status" && args[1] === "--porcelain" && opts?.cwd === worktreePath) {
          injected = true;
          const write = spawnSync(
            "/bin/sh",
            ["-c", `printf 'still working\\n' > ${JSON.stringify(concurrentFile)}`],
          );
          expect(write.status).toBe(0); // the concurrent write itself must have genuinely happened
          expect(fs.existsSync(concurrentFile)).toBe(true);
        }
        return result;
      };

      const manager = new WorktreeManager({ repoRoot: mainDir, worktreeRoot, statePath, runner: racingRunner });

      const reclaimed = manager.isPathFreeForIssue(worktreePath, ISSUE_ID);
      expect(reclaimed).toBe(false);

      // cleanup() repeats the clean check at its destructive boundary, so
      // the concurrent file is noticed and the reclaim refuses it.
      expect(fs.existsSync(concurrentFile)).toBe(true);
    },
  );

  it(
    "reconcileStartup surfaces an active-status worktree whose on-disk content was wiped out from under a still-running process",
    () => {
      const worktreePath = path.join(worktreeRoot, "corrupted-worktree");
      git(mainDir, ["worktree", "add", "-q", worktreePath, "-b", "agent/MOV-TEST-corrupt", "origin/master"]);
      writeState(statePath, {
        [ISSUE_ID]: {
          id: ISSUE_ID, path: worktreePath, branch: "agent/MOV-TEST-corrupt", status: "active", workerPid: 999999,
        },
      });

      // The exact shape this session itself hit while working MOV-195/197:
      // the directory is still *present* (so the existing `!fs.existsSync`
      // recovery branch never fires) but its real content -- including the
      // .git file that makes it a worktree at all -- is gone, while the
      // registry still calls it "active" and the recorded process is still
      // alive (isPidAlive: () => true, matching a live dispatcher/session).
      fs.rmSync(worktreePath, { recursive: true, force: true });
      fs.mkdirSync(worktreePath, { recursive: true });

      const manager = new WorktreeManager({ repoRoot: mainDir, worktreeRoot, statePath, runner: defaultRunner });
      const changes = manager.reconcileStartup({ isPidAlive: () => true });

      // Reconcile must notice the mismatch between the registry and reality
      // instead of treating a surviving empty directory plus live PID as an
      // active worktree.
      expect(changes.some((c) => c.id === ISSUE_ID)).toBe(true);
      expect(changes.find((c) => c.id === ISSUE_ID)).toMatchObject({ to: "abandoned" });
    },
  );
});
