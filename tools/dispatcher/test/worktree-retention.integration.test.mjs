import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { WorktreeManager, DispatcherLock } from "../src/worktree-manager.mjs";
import { WorktreeRetention } from "../src/worktree-retention.mjs";
import { isInsideWorkerSandboxEnv } from "../src/worker-guard.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-29T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/** Hash every file (content + mtime) and directory under `dir`. */
function fingerprint(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { out.push(`d ${p}`); walk(p); }
      else out.push(`f ${p} ${st.mtimeMs} ${st.isSymbolicLink() ? fs.readlinkSync(p) : crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

// These fixtures execute real git, which the worker guard intentionally denies.
// Keep them active in CI and local verification outside a dispatched worker.
const insideWorkerSandbox = isInsideWorkerSandboxEnv();

describe.skipIf(insideWorkerSandbox)("WorktreeRetention against real Git worktrees", () => {
  let tmp, repo, dispatcherRoot, codexRoot, statePath, recoveryDir, registry, linear, calls, opts;

  const snapshot = (id, status, extra = {}) => ({
    identifier: id, stateName: status,
    stateType: status === "Done" ? "completed" : status === "Canceled" ? "canceled" : "started",
    completedAt: status === "Done" ? iso(NOW - 10 * DAY) : null,
    canceledAt: status === "Canceled" ? iso(NOW - 10 * DAY) : null, ...extra,
  });
  const addWorktree = (root, name, branch) => {
    const p = path.join(root, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", branch, p, "master");
    return fs.realpathSync(p);
  };
  const build = (over = {}) => new WorktreeRetention({
    repoRoot: repo, roots: [dispatcherRoot, codexRoot], registry, recoveryDir, now: () => NOW, selfPaths: [tmp + "/none"],
    pathInUse: () => false, isPidAlive: () => false,
    fetchIssue: async (id) => { calls.push(id); if (linear[id] instanceof Error) throw linear[id]; return linear[id] ?? null; },
    ...over,
  });
  const byId = (results, id) => results.find((r) => r.issueId === id);

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retention-")));
    const origin = path.join(tmp, "origin.git");
    repo = path.join(tmp, "main");
    dispatcherRoot = path.join(tmp, "code-worktrees");
    codexRoot = path.join(tmp, "codex-worktrees");
    statePath = path.join(tmp, "state", "worktrees.json");
    recoveryDir = path.join(tmp, "state", "recovery");
    execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin], { env: GIT_ENV });
    execFileSync("git", ["init", "-q", "-b", "master", repo], { env: GIT_ENV });
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "master");
    registry = new WorktreeManager({ repoRoot: repo, worktreeRoot: dispatcherRoot, statePath });
    linear = {};
    calls = [];
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("removes an old Done checkout, retains a young one, and never touches the primary", async () => {
    const oldWt = addWorktree(dispatcherRoot, "MOV-1-old", "agent/MOV-1-old");
    const youngWt = addWorktree(dispatcherRoot, "MOV-2-young", "agent/MOV-2-young");
    linear = { "MOV-1": snapshot("MOV-1", "Done"), "MOV-2": snapshot("MOV-2", "Done", { completedAt: iso(NOW - 2 * DAY) }) };

    const results = await build().run();

    expect(byId(results, "MOV-1")).toMatchObject({ outcome: "removed" });
    expect(byId(results, "MOV-2")).toMatchObject({ outcome: "retained", eligibleAt: iso(NOW + 5 * DAY) });
    expect(results.find((r) => r.path === fs.realpathSync(repo))).toMatchObject({ outcome: "skipped", code: "primary-checkout" });
    expect(fs.existsSync(oldWt)).toBe(false);
    expect(fs.existsSync(youngWt)).toBe(true);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("MOV-1-old");
    expect(git(repo, "branch", "--list", "agent/MOV-1-old")).toContain("agent/MOV-1-old"); // branches are kept
  });

  it("preview reports every candidate and leaves Git, files, registry and locks byte-for-byte unchanged", async () => {
    addWorktree(dispatcherRoot, "MOV-1-old", "agent/MOV-1-old");
    const dirty = addWorktree(dispatcherRoot, "MOV-3-dirty", "agent/MOV-3-dirty");
    fs.writeFileSync(path.join(dirty, "new.txt"), "untracked\n");
    fs.writeFileSync(path.join(dirty, "README.md"), "edited\n");
    git(dirty, "add", "README.md");
    addWorktree(codexRoot, "abc123/moviecal", "agent/MOV-4-codex");
    linear = { "MOV-1": snapshot("MOV-1", "Done"), "MOV-3": snapshot("MOV-3", "Canceled"), "MOV-4": snapshot("MOV-4", "In Progress") };
    const before = fingerprint(tmp);

    const results = await build().preview();

    expect(fingerprint(tmp)).toBe(before);
    expect(fs.existsSync(recoveryDir)).toBe(false);
    expect(byId(results, "MOV-1")).toMatchObject({ outcome: "would-remove", linearStatus: "Done", identity: "directory-name", localChanges: { state: "clean" } });
    expect(byId(results, "MOV-3")).toMatchObject({ outcome: "would-remove", localChanges: { state: "dirty", staged: 1, untracked: 1 } });
    expect(byId(results, "MOV-4")).toMatchObject({ outcome: "skipped", code: "not-terminal", identity: "branch" });
    expect(byId(results, "MOV-1").eligibleAt).toBe(iso(NOW - 3 * DAY));
  });

  it("preserves staged, unstaged, untracked and unpushed work in local refs before removing", async () => {
    const wt = addWorktree(dispatcherRoot, "MOV-5-dirty", "agent/MOV-5-dirty");
    fs.writeFileSync(path.join(wt, "local.txt"), "committed but unpushed\n");
    git(wt, "add", "local.txt");
    git(wt, "commit", "-q", "-m", "local only");
    fs.writeFileSync(path.join(wt, "staged.txt"), "staged\n");
    git(wt, "add", "staged.txt");
    fs.writeFileSync(path.join(wt, "README.md"), "unstaged edit\n");
    fs.writeFileSync(path.join(wt, "untracked.txt"), "untracked\n");
    fs.mkdirSync(path.join(wt, "node_modules"));
    fs.writeFileSync(path.join(wt, "node_modules", "x.js"), "x");
    linear = { "MOV-5": snapshot("MOV-5", "Canceled") };
    const head = git(wt, "rev-parse", "HEAD");

    const [r] = (await build().run()).filter((x) => x.issueId === "MOV-5");

    expect(r.outcome).toBe("removed");
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, "rev-parse", r.preserved.refs.head)).toBe(head);
    expect(git(repo, "show", `${r.preserved.refs.worktree}:untracked.txt`)).toBe("untracked");
    expect(git(repo, "show", `${r.preserved.refs.worktree}:README.md`)).toBe("unstaged edit");
    expect(git(repo, "show", `${r.preserved.refs.index}:staged.txt`)).toBe("staged");
    expect(git(repo, "show", `${r.preserved.refs.head}:local.txt`)).toBe("committed but unpushed");
    const record = JSON.parse(fs.readFileSync(r.preserved.recordPath, "utf8"));
    expect(record).toMatchObject({ issueId: "MOV-5", refs: r.preserved.refs });
    expect(fs.statSync(r.preserved.recordPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(record)).not.toContain("untracked\\n"); // no file contents in the record
    expect(git(repo, "for-each-ref", "refs/remotes/origin", "--format=%(refname)")).not.toContain("moviecal/recovery"); // never pushed
    expect(git(repo, "ls-remote", "origin", "refs/moviecal/*")).toBe("");
  });

  it("is idempotent: a second run reports nothing left to remove and adds no refs", async () => {
    const wt = addWorktree(dispatcherRoot, "MOV-6-x", "agent/MOV-6-x");
    fs.writeFileSync(path.join(wt, "u.txt"), "u\n");
    linear = { "MOV-6": snapshot("MOV-6", "Done") };
    await build().run();
    const refs = git(repo, "for-each-ref", "refs/moviecal");
    const again = await build().run();
    expect(again.some((r) => r.issueId === "MOV-6")).toBe(false);
    expect(git(repo, "for-each-ref", "refs/moviecal")).toBe(refs);
  });

  it("skips ambiguous, unknown, daemon, locked, and outside-root checkouts without asking Linear", async () => {
    addWorktree(dispatcherRoot, "MOV-7-and-MOV-8", "agent/MOV-7-x");
    addWorktree(dispatcherRoot, "plain-name", "docs/plain");
    const daemon = addWorktree(dispatcherRoot, "dispatcher-daemon", "agent/daemon-branch");
    const locked = addWorktree(dispatcherRoot, "MOV-9-locked", "agent/MOV-9-locked");
    git(repo, "worktree", "lock", locked);
    const outside = path.join(tmp, "elsewhere", "MOV-10-outside");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "agent/MOV-10-outside", outside, "master");
    linear = { "MOV-9": snapshot("MOV-9", "Done"), "MOV-10": snapshot("MOV-10", "Done") };

    const results = await build({ excludedPaths: [daemon] }).run();
    const code = (name) => results.find((r) => r.path.endsWith(name))?.code;

    expect(code("MOV-7-and-MOV-8")).toBe("ambiguous-identity");
    expect(code("plain-name")).toBe("unknown-identity");
    expect(code("dispatcher-daemon")).toBe("excluded-checkout");
    expect(code("MOV-9-locked")).toBe("git-locked");
    expect(code("MOV-10-outside")).toBe("outside-roots");
    expect(calls).toEqual([]);
    for (const n of ["MOV-7-and-MOV-8", "plain-name", "dispatcher-daemon", "MOV-9-locked"]) expect(fs.existsSync(path.join(dispatcherRoot, n))).toBe(true);
  });

  it("uses the registry record to identify a checkout whose name and branch carry no id", async () => {
    const wt = addWorktree(codexRoot, "hash/moviecal", "codex/feature");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    registry.saveState({ "MOV-11": { id: "MOV-11", path: wt, branch: "codex/feature", status: "merged", endedAt: iso(NOW - 30 * DAY) } });
    linear = { "MOV-11": snapshot("MOV-11", "Done") };
    const results = await build().run();
    expect(byId(results, "MOV-11")).toMatchObject({ outcome: "removed", identity: "registry" });
    expect(registry.loadState()).toEqual({}); // its terminal registry record goes with it
  });

  it("handles stale registrations and already-absent records distinctly", async () => {
    const stale = addWorktree(dispatcherRoot, "MOV-12-stale", "agent/MOV-12-stale");
    fs.rmSync(stale, { recursive: true, force: true });
    registry.saveState({ "MOV-13": { id: "MOV-13", path: path.join(dispatcherRoot, "MOV-13-gone"), branch: "agent/MOV-13-gone", status: "failed", endedAt: iso(NOW - 30 * DAY) } });
    linear = { "MOV-12": snapshot("MOV-12", "Done"), "MOV-13": snapshot("MOV-13", "Done") };

    const results = await build().run();

    expect(byId(results, "MOV-12")).toMatchObject({ outcome: "removed", code: "removed" });
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("MOV-12-stale");
    expect(byId(results, "MOV-13")).toMatchObject({ outcome: "already-absent" });
    expect(registry.loadState()["MOV-13"]).toBeDefined(); // registry-only records are reported, not rewritten
  });

  it("refuses active registry entries, live pids, pending continuations, and live processes", async () => {
    const a = addWorktree(dispatcherRoot, "MOV-14-active", "agent/MOV-14-active");
    const b = addWorktree(dispatcherRoot, "MOV-15-pid", "agent/MOV-15-pid");
    const c = addWorktree(dispatcherRoot, "MOV-16-resume", "agent/MOV-16-resume");
    const d = addWorktree(dispatcherRoot, "MOV-17-inuse", "agent/MOV-17-inuse");
    const e = addWorktree(dispatcherRoot, "MOV-18-review", "agent/MOV-18-review");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    registry.saveState({
      "MOV-14": { id: "MOV-14", path: a, branch: "agent/MOV-14-active", status: "active" },
      "MOV-15": { id: "MOV-15", path: b, branch: "agent/MOV-15-pid", status: "failed", workerPid: 4242 },
      "MOV-16": { id: "MOV-16", path: c, branch: "agent/MOV-16-resume", status: "failed", retainedForResume: true },
      "MOV-18": { id: "MOV-18", path: e, branch: "agent/MOV-18-review", status: "review", prNumber: 5 },
    });
    linear = Object.fromEntries([14, 15, 16, 17, 18].map((n) => [`MOV-${n}`, snapshot(`MOV-${n}`, "Done")]));

    const results = await build({ isPidAlive: (pid) => pid === 4242, pathInUse: (p) => p === d }).run();

    expect(byId(results, "MOV-14").code).toBe("active-registry");
    expect(byId(results, "MOV-15").code).toBe("live-process");
    expect(byId(results, "MOV-16").code).toBe("pending-continuation");
    expect(byId(results, "MOV-17").code).toBe("in-use");
    expect(byId(results, "MOV-18").code).toBe("active-registry");
    for (const p of [a, b, c, d, e]) expect(fs.existsSync(p)).toBe(true);
  });

  it("refuses a checkout a real process is standing in", async () => {
    const wt = addWorktree(dispatcherRoot, "MOV-19-busy", "agent/MOV-19-busy");
    linear = { "MOV-19": snapshot("MOV-19", "Done") };
    const child = spawn("sleep", ["30"], { cwd: wt, stdio: "ignore" });
    try {
      const { defaultPathInUse } = await import("../src/worktree-retention.mjs");
      const results = await build({ pathInUse: defaultPathInUse }).run();
      expect(byId(results, "MOV-19")).toMatchObject({ outcome: "skipped", code: "in-use" });
      expect(fs.existsSync(wt)).toBe(true);
    } finally { child.kill(); }
  });

  it("removes only documented regenerable ignored artifacts and skips anything else ignored", async () => {
    const ok = addWorktree(dispatcherRoot, "MOV-20-regen", "agent/MOV-20-regen");
    const bad = addWorktree(dispatcherRoot, "MOV-21-ignored", "agent/MOV-21-ignored");
    const realEnv = addWorktree(dispatcherRoot, "MOV-22-realenv", "agent/MOV-22-realenv");
    for (const w of [ok, bad, realEnv]) {
      fs.writeFileSync(path.join(w, ".gitignore"), "node_modules/\n.env.local\nnotes.private\n");
      git(w, "add", ".gitignore");
      git(w, "commit", "-q", "-m", "ignore");
      git(w, "push", "-q", "origin", `HEAD:refs/heads/${path.basename(w)}`);
      fs.mkdirSync(path.join(w, "node_modules"));
      fs.writeFileSync(path.join(w, "node_modules", "a.js"), "a");
    }
    fs.writeFileSync(path.join(tmp, "shared.env"), "SECRET=1\n");
    fs.symlinkSync(path.join(tmp, "shared.env"), path.join(ok, ".env.local"));
    fs.writeFileSync(path.join(bad, "notes.private"), "precious\n");
    fs.writeFileSync(path.join(realEnv, ".env.local"), "HAND_WRITTEN=1\n");
    linear = Object.fromEntries([20, 21, 22].map((n) => [`MOV-${n}`, snapshot(`MOV-${n}`, "Done")]));

    const results = await build().run();

    expect(byId(results, "MOV-20"), JSON.stringify(byId(results, "MOV-20"))).toMatchObject({ outcome: "removed" });
    expect(fs.readFileSync(path.join(tmp, "shared.env"), "utf8")).toBe("SECRET=1\n"); // symlink target survives
    expect(byId(results, "MOV-21")).toMatchObject({ outcome: "skipped", code: "ignored-files" });
    expect(byId(results, "MOV-22")).toMatchObject({ outcome: "skipped", code: "ignored-files" });
    expect(fs.readFileSync(path.join(bad, "notes.private"), "utf8")).toBe("precious\n");
  });

  it("never snapshots credential-like files: the checkout is kept and no recovery ref is made", async () => {
    const wt = addWorktree(dispatcherRoot, "MOV-23-secret", "agent/MOV-23-secret");
    fs.writeFileSync(path.join(wt, ".env.production"), "TOKEN=abc\n");
    linear = { "MOV-23": snapshot("MOV-23", "Done") };
    const results = await build().run();
    expect(byId(results, "MOV-23")).toMatchObject({ outcome: "skipped", code: "credential-file" });
    expect(JSON.stringify(results)).not.toContain("abc");
    expect(git(repo, "for-each-ref", "refs/moviecal")).toBe("");
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("keeps conflicted checkouts", async () => {
    const wt = addWorktree(dispatcherRoot, "MOV-24-conflict", "agent/MOV-24-conflict");
    git(wt, "checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(wt, "README.md"), "side\n"); git(wt, "commit", "-qam", "side");
    git(wt, "checkout", "-q", "agent/MOV-24-conflict");
    fs.writeFileSync(path.join(wt, "README.md"), "main\n"); git(wt, "commit", "-qam", "main");
    spawnSync("git", ["merge", "side"], { cwd: wt, env: GIT_ENV });
    linear = { "MOV-24": snapshot("MOV-24", "Done") };
    expect(byId(await build().run(), "MOV-24")).toMatchObject({ outcome: "skipped", code: "unmerged-paths" });
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("fails closed on Linear errors, unknown issues, missing timestamps, and non-terminal states", async () => {
    const names = { 30: "boom", 31: "missing", 32: "notime", 33: "active" };
    for (const [n, s] of Object.entries(names)) addWorktree(dispatcherRoot, `MOV-${n}-${s}`, `agent/MOV-${n}-${s}`);
    linear = {
      "MOV-30": new Error("network down"),
      "MOV-32": snapshot("MOV-32", "Done", { completedAt: null }),
      "MOV-33": snapshot("MOV-33", "In Progress"),
    };
    const results = await build().run();
    expect(byId(results, "MOV-30")).toMatchObject({ code: "linear-unavailable", outcome: "skipped" });
    expect(byId(results, "MOV-31").code).toBe("linear-unknown");
    expect(byId(results, "MOV-32").code).toBe("linear-unknown");
    expect(byId(results, "MOV-33").code).toBe("not-terminal");
    for (const [n, s] of Object.entries(names)) expect(fs.existsSync(path.join(dispatcherRoot, `MOV-${n}-${s}`))).toBe(true);
  });

  it("re-reads Linear before deleting: a status change after evaluation blocks removal", async () => {
    const wt = addWorktree(dispatcherRoot, "MOV-40-flip", "agent/MOV-40-flip");
    fs.writeFileSync(path.join(wt, "u.txt"), "u\n");
    let reads = 0;
    const results = await build({ fetchIssue: async () => (++reads === 1 ? snapshot("MOV-40", "Done") : snapshot("MOV-40", "In Progress")) }).run();
    expect(reads).toBe(2);
    expect(byId(results, "MOV-40")).toMatchObject({ outcome: "skipped", code: "status-changed" });
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("aborts when the checkout changes during preservation", async () => {
    const wt = addWorktree(dispatcherRoot, "MOV-41-race", "agent/MOV-41-race");
    fs.writeFileSync(path.join(wt, "u.txt"), "u\n");
    let reads = 0;
    const results = await build({
      fetchIssue: async () => { if (++reads === 2) fs.writeFileSync(path.join(wt, "late.txt"), "written by a concurrent editor\n"); return snapshot("MOV-41", "Done"); },
    }).run();
    expect(byId(results, "MOV-41")).toMatchObject({ outcome: "skipped", code: "changed-during-cleanup" });
    expect(fs.readFileSync(path.join(wt, "late.txt"), "utf8")).toContain("concurrent");
  });

  it("honours a longer configured retention", async () => {
    const wt = addWorktree(dispatcherRoot, "MOV-42-long", "agent/MOV-42-long");
    linear = { "MOV-42": snapshot("MOV-42", "Done") };
    expect(byId(await build({ retentionDays: 14 }).run(), "MOV-42")).toMatchObject({ outcome: "retained", eligibleAt: iso(NOW + 4 * DAY) });
    expect(fs.existsSync(wt)).toBe(true);
  });
});

describe.skipIf(insideWorkerSandbox)("dispatcher gc command", () => {
  const cli = path.resolve(import.meta.dirname, "../bin/dispatcher.mjs");
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-cli-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const env = () => ({
    PATH: process.env.PATH, HOME: tmp, MOVIECAL_CONFIG_DIR: path.join(tmp, "cfg"), MOVIECAL_WORKTREE_ROOT: path.join(tmp, "wt"),
    MOVIECAL_WORKTREE_ROOTS: path.join(tmp, "wt"), MOVIECAL_LOG_ROOT: path.join(tmp, "logs"),
  });

  it("exits 2 without touching anything when the dispatcher lock is held", () => {
    fs.mkdirSync(path.join(tmp, "cfg"), { recursive: true });
    const lock = new DispatcherLock(path.join(tmp, "cfg", "dispatcher.lock"));
    lock.acquire();
    try {
      const r = spawnSync(process.execPath, [cli, "gc"], { env: env(), encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("already running");
    } finally { lock.release(); }
  });

  it("previews without a credential, without taking the lock, and reports machine-readable JSON", () => {
    const r = spawnSync(process.execPath, [cli, "gc", "--dry-run", "--json"], { env: env(), encoding: "utf8" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ dryRun: true, retentionDays: 7 });
    expect(fs.existsSync(path.join(tmp, "cfg", "dispatcher.lock"))).toBe(false);
  });

  it("rejects an invalid retention and unknown options", () => {
    for (const args of [["--retention-days", "0"], ["--bogus"]]) {
      expect(spawnSync(process.execPath, [cli, "gc", ...args], { env: env(), encoding: "utf8" }).status).toBe(1);
    }
  });
});
