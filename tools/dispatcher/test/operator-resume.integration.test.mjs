import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeManager } from "../src/worktree-manager.mjs";
import { inspectOperatorResume } from "../src/operator-resume.mjs";
import { publishWorkerResult } from "../src/worker-publish.mjs";

// The dispatcher worker's OS guard denies Git process execution. CI and an
// operator shell run this real-worktree fixture; workers run the pure suite.
const suite = process.env.MOVIECAL_WORKER_SANDBOX ? describe.skip : describe;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

suite("operator resume real-worktree fixture", () => {
  it("previews byte-for-byte without writes and publishes only the original branch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-operator-resume-"));
    roots.push(root);
    const main = path.join(root, "main");
    const remote = path.join(root, "remote.git");
    const worktreeRoot = path.join(root, "worktrees");
    const statePath = path.join(root, "state", "worktrees.json");
    fs.mkdirSync(main);
    fs.mkdirSync(worktreeRoot);
    const git = (args, cwd = main) => String(execFileSync("git", args, { cwd, encoding: "utf8" })).trim();
    git(["init", "--bare", remote]);
    git(["init", "-b", "master"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    fs.writeFileSync(path.join(main, "README.md"), "base\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "base"]);
    git(["remote", "add", "origin", remote]);
    git(["push", "-u", "origin", "master"]);
    const manager = new WorktreeManager({ repoRoot: main, worktreeRoot, statePath,
      trustWorkspaceFn: () => ({ ok: true }) });
    const id = "MOV-123";
    const branch = "agent/MOV-123-example";
    const issue = {
      id: "linear-fixture-uuid", identifier: id, title: "Example", stateName: "Needs Human Decision",
      url: "https://linear.app/moviecal/issue/MOV-123/example",
      description: "## Acceptance criteria\n- [ ] Finish\n## Testing Expectations\nUnit and integration",
      labels: ["execution:mac", "worker:codex", "model:strong", "upgrade:security-critical"],
      delegate: { name: "moviecal-dispatcher" }, blockedByIds: [], inverseRelations: [],
      recentComments: ["**Worker timed out after 2700000ms and was killed.**"],
    };
    const entry = manager.create({ id, name: "MOV-123-example", branch, worker: "codex", model: "strong",
      linearUrl: issue.url, linearIssueId: issue.id, repository: "PelvicSorcerer/moviecal" });
    git(["config", "user.name", "Fixture"], entry.path);
    git(["config", "user.email", "fixture@example.invalid"], entry.path);
    fs.writeFileSync(path.join(entry.path, "committed.txt"), "unpublished\n");
    git(["add", "committed.txt"], entry.path);
    git(["commit", "-m", "partial implementation"], entry.path);
    fs.writeFileSync(path.join(entry.path, "README.md"), "staged\n");
    git(["add", "README.md"], entry.path);
    fs.writeFileSync(path.join(entry.path, "untracked.txt"), "untracked\n");
    manager.setWorkerPid(id, 2147483000); // An exited historical worker PID, retained by markStatus.
    manager.markStatus(id, "failed");
    const ctx = {
      worktreeManager: manager, worktreeRoot, logRoot: path.join(root, "logs"), ghRepo: "PelvicSorcerer/moviecal",
      dispatcherDelegate: { name: "moviecal-dispatcher" }, iosRunnerOnline: true, concurrencyLimit: 1,
      secretPresent: () => true, issueSpecMode: "off", steeringEnabled: false,
      workerCooldownStore: { state: () => ({ cooling: false, probeOwed: false }) },
      circuitBreaker: { status: (name) => ({ name, open: false }) },
    };
    const indexPath = git(["rev-parse", "--path-format=absolute", "--git-path", "index"], entry.path);
    const stateBefore = fs.readFileSync(statePath);
    const indexBefore = fs.readFileSync(indexPath);
    const headBefore = git(["rev-parse", "HEAD"], entry.path);
    const preview = inspectOperatorResume(issue, ctx, { findPrFn: () => null });
    expect(preview.admitted).toBe(true);
    expect(preview.changedPaths).toContain("README.md");
    expect(preview.changedPaths).toContain("untracked.txt");
    expect(preview.unpublishedCommits).toBe(1);
    expect(fs.readFileSync(statePath).equals(stateBefore)).toBe(true);
    expect(fs.readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(git(["rev-parse", "HEAD"], entry.path)).toBe(headBefore);
    expect(fs.readFileSync(path.join(entry.path, "untracked.txt"), "utf8")).toBe("untracked\n");

    let created = false;
    const runner = (command, args, options) => {
      if (command === "gh") {
        if (args[0] === "pr" && args[1] === "list") return created
          ? JSON.stringify([{ number: 7, url: "https://github.example/pr/7", isDraft: true, headRefOid: null }]) : "[]";
        if (args[0] === "pr" && args[1] === "create") { created = true; return ""; }
        throw new Error("unexpected GitHub command");
      }
      return execFileSync(command, args, { encoding: "utf8", ...options });
    };
    const pr = publishWorkerResult({ worktreePath: entry.path, branch, repo: ctx.ghRepo,
      issue, allowExistingCommits: true, requireNewPr: true, runner });
    expect(pr.number).toBe(7);
    expect(git(["rev-parse", `refs/heads/${branch}`], remote)).toBe(git(["rev-parse", "HEAD"], entry.path));
    expect(git(["branch", "--show-current"], entry.path)).toBe(branch);
    expect(fs.readFileSync(path.join(entry.path, "untracked.txt"), "utf8")).toBe("untracked\n");
  });
});
