// Integration coverage for the trusted worktree dependency install (MOV-411):
// a fixture worktree with a real npm lockfile, the real process spawn and
// process-group cleanup, and a fake `npm` executable on the module's spawn
// seam, so nothing reaches the network or a real npm.
//
// Each scenario runs twice. The "git" variant commits the fixture and reads
// HEAD through the module's default Git reader; like the other real-Git
// fixtures it is skipped inside a dispatcher worker's sandbox, where `git`
// process-exec is denied (MOV-274 follow-up), and runs in CI and any local
// run outside it. The "snapshot" variant injects the fixture's committed
// bytes instead, so the install behaviour stays covered everywhere.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEPENDENCY_INPUT_FILES,
  ensureWorktreeDependencies,
  readInstallMarker,
  renderDependencyInstallBlocker,
  writeDependencyInstallRecord,
} from "../src/dependency-install.mjs";
import { isInsideWorkerSandboxEnv } from "../src/worker-guard.mjs";

const insideWorkerSandbox = isInsideWorkerSandboxEnv();

const PACKAGE_JSON = `${JSON.stringify({ name: "fixture", version: "1.0.0", private: true }, null, 2)}\n`;
const LOCKFILE = `${JSON.stringify({
  name: "fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "fixture", version: "1.0.0" } },
}, null, 2)}\n`;

// Behaviour is selected by a `mode` file beside the script, because the
// install environment is deliberately scrubbed.
const FAKE_NPM = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dir = __dirname;
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim();
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + "\\n");
console.log("fake npm: added 460 packages");
console.error("fake npm: warn deprecated something");
const writeToolchain = (names) => {
  fs.rmSync("node_modules", { recursive: true, force: true });
  fs.mkdirSync(path.join("node_modules", ".bin"), { recursive: true });
  for (const name of names) fs.writeFileSync(path.join("node_modules", ".bin", name), "#!/bin/sh\\n", { mode: 0o755 });
};
if (mode === "success") writeToolchain(["tsc", "next", "vitest"]);
else if (mode === "partial") writeToolchain(["tsc", "next"]);
else if (mode === "fail") { console.error("npm ERR! code ENOTFOUND"); process.exit(1); }
else if (mode === "hang") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "pids.json"), JSON.stringify({ npm: process.pid, grandchild: grandchild.pid }));
  setInterval(() => {}, 1000);
}
`;

let root;
let worktree;
let logDir;
let fakeBin;
let npmCommand;

function git(args) {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: worktree, encoding: "utf8" });
}

function setMode(mode) {
  fs.writeFileSync(path.join(fakeBin, "mode"), mode);
}

function npmCalls() {
  const file = path.join(fakeBin, "calls.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitForDeath(pids, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return pids.filter(isAlive);
}

const modes = [
  { name: "git", skip: insideWorkerSandbox },
  { name: "snapshot", skip: false },
];

describe.each(modes)("ensureWorktreeDependencies with a fixture worktree ($name HEAD reader)", ({ name, skip }) => {
  let readCommittedInputs;

  beforeEach(() => {
    if (skip) return;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dependency-install-int-")));
    worktree = path.join(root, "worktree");
    logDir = path.join(root, "logs", "MOV-TEST-fixture");
    fakeBin = path.join(root, "fake-bin");
    npmCommand = path.join(fakeBin, "npm");
    fs.mkdirSync(worktree);
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(npmCommand, FAKE_NPM, { mode: 0o755 });
    setMode("success");
    fs.writeFileSync(path.join(worktree, "package.json"), PACKAGE_JSON);
    fs.writeFileSync(path.join(worktree, "package-lock.json"), LOCKFILE);
    fs.writeFileSync(path.join(worktree, "README.md"), "fixture\n");
    fs.writeFileSync(path.join(logDir, "stdout.log"), "worker transcript\n");

    if (name === "git") {
      git(["init", "-q"]);
      git(["add", "package.json", "package-lock.json", "README.md"]);
      git(["commit", "-q", "-m", "fixture"]);
      readCommittedInputs = undefined;
    } else {
      const snapshot = Object.fromEntries(DEPENDENCY_INPUT_FILES.map((file) => {
        const filePath = path.join(worktree, file);
        return [file, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null];
      }));
      readCommittedInputs = () => ({ headSha: "f".repeat(40), files: snapshot });
    }
  });

  afterEach(() => {
    if (!skip) fs.rmSync(root, { recursive: true, force: true });
  });

  const install = (overrides = {}) => ensureWorktreeDependencies({
    worktreePath: worktree,
    logDir,
    npmCommand,
    ...(readCommittedInputs ? { readCommittedInputs } : {}),
    sourceEnv: {
      PATH: `${worktree}/node_modules/.bin:/usr/bin:/bin`,
      HOME: os.homedir(),
      MOVIECAL_WORKER_SANDBOX: "1",
      npm_config_registry: "https://registry.evil.example",
      NPM_CONFIG_USERCONFIG: path.join(root, "user.npmrc"),
      NPM_TOKEN: "npm_poisoned",
      GITHUB_TOKEN: "ghp_poisoned",
      LINEAR_API_KEY: "lin_api_poisoned",
      ANTHROPIC_API_KEY: "sk-ant-poisoned",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-poisoned",
    },
    timeoutMs: 20_000,
    killGraceMs: 200,
    ...overrides,
  });

  it.skipIf(skip)("installs a fresh worktree with a clean environment and stamps the marker", async () => {
    const result = await install();

    expect(result).toMatchObject({ ok: true, status: "installed", installReason: "fresh", exitCode: 0 });
    if (name === "git") expect(result.headSha).toBe(git(["rev-parse", "HEAD"]).trim());
    const calls = npmCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["ci", "--ignore-scripts", "--userconfig=/dev/null", "--no-audit", "--no-fund", "--no-update-notifier"]);
    expect(calls[0].cwd).toBe(worktree);
    const envKeys = Object.keys(calls[0].env);
    expect(envKeys.filter((key) => /TOKEN|SECRET|_KEY|AUTH|CREDENTIAL|PASSWORD/i.test(key))).toEqual([]);
    expect(envKeys.filter((key) => /^npm_config_/i.test(key))).toEqual([]);
    expect(calls[0].env).not.toHaveProperty("MOVIECAL_WORKER_SANDBOX");
    expect(calls[0].env.PATH).toBe("/usr/bin:/bin");
    expect(JSON.stringify(calls[0].env)).not.toMatch(/poisoned|evil\.example/);
    expect(readInstallMarker(worktree)).toMatchObject({ state: "valid", marker: { lockfileSha256: result.lockfileSha256 } });

    const log = fs.readFileSync(path.join(logDir, "dependency-install.log"), "utf8");
    expect(log).toContain("fake npm: added 460 packages");
    expect(log).toContain("fake npm: warn deprecated something");
    expect(fs.readFileSync(path.join(logDir, "stdout.log"), "utf8")).toBe("worker transcript\n");
    const recordPath = writeDependencyInstallRecord(logDir, result);
    expect(recordPath).toBe(path.join(logDir, "dependency-install.json"));
    expect(JSON.parse(fs.readFileSync(recordPath, "utf8"))).toMatchObject({ ok: true, status: "installed" });
  });

  it.skipIf(skip)("repairs a partial node_modules whose toolchain binaries are missing", async () => {
    fs.mkdirSync(path.join(worktree, "node_modules", ".bin"), { recursive: true });
    fs.mkdirSync(path.join(worktree, "node_modules", "vitest"));
    fs.writeFileSync(path.join(worktree, "node_modules", ".bin", "tsc"), "#!/bin/sh\n", { mode: 0o755 });

    const result = await install();

    expect(result).toMatchObject({ ok: true, status: "installed", installReason: "toolchain-incomplete" });
    expect(fs.existsSync(path.join(worktree, "node_modules", ".bin", "vitest"))).toBe(true);
  });

  it.skipIf(skip)("leaves a complete, current install untouched", async () => {
    expect((await install()).status).toBe("installed");
    const markerBefore = fs.readFileSync(path.join(worktree, "node_modules", ".moviecal-dependency-install.json"), "utf8");

    const second = await install();

    expect(second).toMatchObject({ ok: true, status: "current" });
    expect(npmCalls()).toHaveLength(1);
    expect(fs.readFileSync(path.join(worktree, "node_modules", ".moviecal-dependency-install.json"), "utf8")).toBe(markerBefore);
  });

  it.skipIf(skip)("reinstalls over a truncated marker", async () => {
    await install();
    fs.writeFileSync(path.join(worktree, "node_modules", ".moviecal-dependency-install.json"), '{"schemaVersion":1,"lock');

    const result = await install();

    expect(result).toMatchObject({ ok: true, status: "installed", installReason: "marker-corrupt" });
    expect(npmCalls()).toHaveLength(2);
    expect(readInstallMarker(worktree).state).toBe("valid");
  });

  it.skipIf(skip)("reports an npm failure without a marker and keeps output in the install log", async () => {
    setMode("fail");

    const result = await install();

    expect(result).toMatchObject({ ok: false, reason: "npm-failed", exitCode: 1 });
    expect(readInstallMarker(worktree).state).toBe("missing");
    expect(fs.readFileSync(path.join(logDir, "dependency-install.log"), "utf8")).toContain("npm ERR! code ENOTFOUND");
    expect(fs.readFileSync(path.join(logDir, "stdout.log"), "utf8")).toBe("worker transcript\n");
    expect(renderDependencyInstallBlocker(result)).toContain("`npm-failed`");
  });

  it.skipIf(skip)("fails when npm exits cleanly but leaves the toolchain incomplete", async () => {
    setMode("partial");
    const result = await install();
    expect(result).toMatchObject({ ok: false, reason: "toolchain-incomplete-after-install", missingBinaries: ["vitest"] });
  });

  it.skipIf(skip)("kills a timed-out npm and everything in its process group", async () => {
    setMode("hang");
    const spawned = [];

    const result = await install({ timeoutMs: 1500, onSpawn: ({ pid }) => spawned.push(pid) });

    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    const pids = JSON.parse(fs.readFileSync(path.join(fakeBin, "pids.json"), "utf8"));
    expect(spawned).toEqual([pids.npm]);
    expect(await waitForDeath([pids.npm, pids.grandchild])).toEqual([]);
  });

  it.skipIf(skip)("refuses dirty dependency inputs without running npm", async () => {
    fs.appendFileSync(path.join(worktree, "package-lock.json"), "\n");
    fs.writeFileSync(path.join(worktree, ".npmrc"), "registry=https://registry.evil.example/\n");

    const result = await install();

    expect(result).toMatchObject({
      ok: false,
      reason: "dirty-dependency-inputs",
      dirtyInputs: [
        { path: "package-lock.json", reason: "modified" },
        { path: ".npmrc", reason: "untracked" },
      ],
    });
    expect(npmCalls()).toEqual([]);
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
    expect(renderDependencyInstallBlocker(result)).toContain("`.npmrc` (untracked)");
  });
});
