// Unit coverage for the trusted worktree dependency install (MOV-411). Every
// test injects the HEAD reader, process spawn, timers and kill seams, so no
// test touches Git, the network or a real npm. Worktrees are temp dirs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEPENDENCY_INSTALL_MARKER,
  DEPENDENCY_INSTALL_RECORD,
  INSTALL_SCRIPT_ALLOWLIST,
  REQUIRED_TOOLCHAIN_BINARIES,
  allowlistedScriptArguments,
  dependencyInstallEnvironment,
  ensureWorktreeDependencies,
  findDirtyDependencyInputs,
  guardParentExit,
  inspectToolchain,
  installArguments,
  installNeed,
  readCommittedDependencyInputs,
  readInstallMarker,
  renderDependencyInstallBlocker,
  writeDependencyInstallRecord,
} from "../src/dependency-install.mjs";

const PACKAGE_JSON = Buffer.from('{"name":"fixture","version":"1.0.0"}\n');
const LOCKFILE = Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n');
const LOCK_SHA = createHash("sha256").update(LOCKFILE).digest("hex");
const HEAD = "a".repeat(40);

let root;
let worktree;
let logDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-install-unit-"));
  worktree = path.join(root, "worktree");
  logDir = path.join(root, "logs");
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, "package.json"), PACKAGE_JSON);
  fs.writeFileSync(path.join(worktree, "package-lock.json"), LOCKFILE);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function committed(files = {}) {
  return () => ({
    headSha: HEAD,
    files: { "package.json": PACKAGE_JSON, "package-lock.json": LOCKFILE, "npm-shrinkwrap.json": null, ".npmrc": null, ...files },
  });
}

function writeBinaries(names = REQUIRED_TOOLCHAIN_BINARIES) {
  const bin = path.join(worktree, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
}

function writeMarker(content) {
  fs.mkdirSync(path.join(worktree, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(worktree, DEPENDENCY_INSTALL_MARKER), content);
}

function validMarker(lockfileSha256 = LOCK_SHA) {
  return JSON.stringify({ schemaVersion: 1, lockfileSha256, installedAt: "2026-09-28T00:00:00.000Z" });
}

function manualTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      pending.set(++seq, { fn, ms });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fireNext() {
      const [id, entry] = pending.entries().next().value;
      pending.delete(id);
      entry.fn();
    },
  };
}

/** A spawn fake whose children exit when told; `onSpawn(child)` may simulate npm's effects. */
function fakeSpawn({ onSpawn } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4000 + calls.length;
    calls.push({ command, args, options, child });
    onSpawn?.(child, args);
    return child;
  };
  return { spawnImpl, calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function baseOptions(overrides = {}) {
  return {
    worktreePath: worktree,
    logDir,
    sourceEnv: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
    readCommittedInputs: committed(),
    killImpl: () => {},
    processImpl: new EventEmitter(),
    timers: manualTimers(),
    ...overrides,
  };
}

describe("dependencyInstallEnvironment", () => {
  it("strips credentials, npm configuration, the sandbox marker and worktree PATH entries from a poisoned environment", () => {
    const env = dependencyInstallEnvironment({
      PATH: `/usr/bin:relative/bin:${worktree}/node_modules/.bin:/opt/homebrew/bin`,
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      MOVIECAL_WORKER_SANDBOX: "1",
      MOVIECAL_CONFIG_DIR: "/tmp/config",
      npm_config_registry: "https://evil.example",
      NPM_CONFIG_USERCONFIG: "/Users/test/.npmrc",
      npm_config__auth: "dXNlcjpwYXNz",
      npm_package_name: "moviecal",
      NPM_TOKEN: "npm-token",
      NODE_AUTH_TOKEN: "node-auth",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
      OPENAI_API_KEY: "sk-openai",
      CODEX_HOME: "/Users/test/.codex",
      LINEAR_API_KEY: "lin_api",
      LINEAR_APP_CLIENT_ID: "client",
      GITHUB_TOKEN: "ghp",
      GH_ENTERPRISE_TOKEN: "ghe",
      GIT_DIR: "/tmp/other.git",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      AWS_SECRET_ACCESS_KEY: "aws",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
      NODE_OPTIONS: "--require /tmp/hook.js",
      HTTPS_PROXY: "http://user:pass@proxy.example:8080",
      HTTP_PROXY: "http://proxy.example:8080",
    }, { worktreePath: worktree });

    expect(env.PATH).toBe("/usr/bin:/opt/homebrew/bin");
    expect(env.HOME).toBe("/Users/test");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.HTTP_PROXY).toBe("http://proxy.example:8080");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_ASKPASS).toBe("/usr/bin/false");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    const keys = Object.keys(env);
    expect(keys.filter((key) => /^npm_/i.test(key))).toEqual([]);
    expect(keys.filter((key) => /TOKEN|SECRET|KEY|AUTH|CREDENTIAL|PASSWORD/i.test(key))).toEqual([]);
    for (const key of ["MOVIECAL_WORKER_SANDBOX", "MOVIECAL_CONFIG_DIR", "CODEX_HOME", "LINEAR_APP_CLIENT_ID", "GIT_DIR", "SSH_AUTH_SOCK", "GH_CONFIG_DIR", "NODE_OPTIONS", "HTTPS_PROXY"]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(Object.values(env).join("\n")).not.toMatch(/sk-|ghp|lin_api|npm-token|user:pass|evil\.example/);
  });
});

describe("npm arguments", () => {
  it("runs npm ci with scripts disabled and the user npmrc ignored", () => {
    expect(installArguments()).toEqual(["ci", "--ignore-scripts", "--userconfig=/dev/null", "--no-audit", "--no-fund", "--no-update-notifier"]);
    expect(installArguments()).not.toContain("install");
  });

  it("keeps the lifecycle-script allowlist empty and names allowlisted packages only in a separate rebuild", () => {
    expect(INSTALL_SCRIPT_ALLOWLIST).toEqual([]);
    expect(Object.isFrozen(INSTALL_SCRIPT_ALLOWLIST)).toBe(true);
    expect(allowlistedScriptArguments(["esbuild"])).toEqual(["rebuild", "--userconfig=/dev/null", "--no-audit", "--no-fund", "--no-update-notifier", "esbuild"]);
  });
});

describe("toolchain and marker detection", () => {
  it("reports a missing node_modules as absent with every binary missing", () => {
    expect(inspectToolchain(worktree)).toEqual({ present: false, safe: true, missingBinaries: ["tsc", "next", "vitest"] });
  });

  it("does not treat a populated node_modules without .bin/vitest as complete", () => {
    writeBinaries(["tsc", "next"]);
    fs.mkdirSync(path.join(worktree, "node_modules", "vitest"), { recursive: true });
    expect(inspectToolchain(worktree).missingBinaries).toEqual(["vitest"]);
  });

  it("counts dangling and non-executable binaries as missing", () => {
    writeBinaries(["tsc"]);
    fs.symlinkSync("../does-not-exist/next.js", path.join(worktree, "node_modules", ".bin", "next"));
    fs.writeFileSync(path.join(worktree, "node_modules", ".bin", "vitest"), "x", { mode: 0o644 });
    expect(inspectToolchain(worktree).missingBinaries).toEqual(["next", "vitest"]);
  });

  it("flags a symlinked node_modules as unsafe", () => {
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(worktree, "node_modules"));
    expect(inspectToolchain(worktree).safe).toBe(false);
  });

  it("parses missing, valid, truncated, wrong-shape and oversized markers without throwing", () => {
    expect(readInstallMarker(worktree)).toEqual({ state: "missing" });
    writeMarker(validMarker());
    expect(readInstallMarker(worktree)).toMatchObject({ state: "valid", marker: { lockfileSha256: LOCK_SHA } });
    writeMarker(validMarker().slice(0, 20));
    expect(readInstallMarker(worktree)).toEqual({ state: "corrupt", detail: "marker is not valid JSON" });
    writeMarker(JSON.stringify({ schemaVersion: 1, lockfileSha256: "not-a-hash", installedAt: "x" }));
    expect(readInstallMarker(worktree).state).toBe("corrupt");
    writeMarker("null");
    expect(readInstallMarker(worktree).state).toBe("corrupt");
    writeMarker(" ".repeat(70 * 1024));
    expect(readInstallMarker(worktree).state).toBe("corrupt");
  });

  it("decides why an install is needed", () => {
    const complete = { present: true, safe: true, missingBinaries: [] };
    const valid = { state: "valid", marker: { lockfileSha256: LOCK_SHA } };
    expect(installNeed({ present: false, safe: true, missingBinaries: ["tsc"] }, valid, LOCK_SHA)).toBe("fresh");
    expect(installNeed({ ...complete, missingBinaries: ["vitest"] }, valid, LOCK_SHA)).toBe("toolchain-incomplete");
    expect(installNeed(complete, { state: "missing" }, LOCK_SHA)).toBe("marker-missing");
    expect(installNeed(complete, { state: "corrupt" }, LOCK_SHA)).toBe("marker-corrupt");
    expect(installNeed(complete, valid, "b".repeat(64))).toBe("marker-stale");
    expect(installNeed(complete, valid, LOCK_SHA)).toBeNull();
  });
});

describe("readCommittedDependencyInputs", () => {
  function fakeGit(listing) {
    const calls = [];
    const execImpl = (command, args) => {
      calls.push([command, ...args]);
      const sub = args.slice(2);
      if (sub[0] === "rev-parse") return Buffer.from(`${HEAD}\n`);
      if (sub[0] === "ls-tree") return Buffer.from(listing);
      if (sub[0] === "cat-file") return Buffer.from(`blob:${sub[2]}`);
      throw new Error(`unexpected git ${sub.join(" ")}`);
    };
    return { execImpl, calls };
  }

  it("reads each committed input's blob at the resolved HEAD and reports absent inputs as null", () => {
    const { execImpl, calls } = fakeGit("100644 blob 111\tpackage.json\x00100644 blob 222\tpackage-lock.json\x00");
    const result = readCommittedDependencyInputs(worktree, { execImpl });
    expect(result.headSha).toBe(HEAD);
    expect(String(result.files["package.json"])).toBe("blob:111");
    expect(String(result.files["package-lock.json"])).toBe("blob:222");
    expect(result.files[".npmrc"]).toBeNull();
    expect(result.files["npm-shrinkwrap.json"]).toBeNull();
    expect(calls[1]).toEqual(["git", "-C", worktree, "ls-tree", "-z", HEAD, "--", "package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc"]);
  });

  it("rejects a committed input that is a symlink", () => {
    const { execImpl } = fakeGit("120000 blob 333\tpackage-lock.json\x00");
    expect(() => readCommittedDependencyInputs(worktree, { execImpl })).toThrow(/not a regular file/);
  });
});

describe("findDirtyDependencyInputs", () => {
  it("accepts inputs identical to HEAD", () => {
    expect(findDirtyDependencyInputs(worktree, committed()().files)).toEqual([]);
  });

  it("reports modified, missing and untracked inputs", () => {
    fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"changed"}\n');
    fs.rmSync(path.join(worktree, "package-lock.json"));
    fs.writeFileSync(path.join(worktree, ".npmrc"), "registry=https://evil.example\n");
    fs.writeFileSync(path.join(worktree, "npm-shrinkwrap.json"), "{}");
    expect(findDirtyDependencyInputs(worktree, committed()().files)).toEqual([
      { path: "package.json", reason: "modified" },
      { path: "package-lock.json", reason: "missing" },
      { path: "npm-shrinkwrap.json", reason: "untracked" },
      { path: ".npmrc", reason: "untracked" },
    ]);
  });

  it("reports a symlink in place of a committed input", () => {
    fs.writeFileSync(path.join(root, "lock-copy.json"), LOCKFILE);
    fs.rmSync(path.join(worktree, "package-lock.json"));
    fs.symlinkSync(path.join(root, "lock-copy.json"), path.join(worktree, "package-lock.json"));
    expect(findDirtyDependencyInputs(worktree, committed()().files)).toEqual([{ path: "package-lock.json", reason: "not-regular-file" }]);
  });
});

describe("ensureWorktreeDependencies", () => {
  it("leaves a complete, current install untouched without spawning npm", async () => {
    writeBinaries();
    writeMarker(validMarker());
    const { spawnImpl, calls } = fakeSpawn();
    const result = await ensureWorktreeDependencies(baseOptions({ spawnImpl }));
    expect(result).toMatchObject({ ok: true, status: "current", headSha: HEAD, lockfileSha256: LOCK_SHA });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(logDir, "dependency-install.log"))).toBe(false);
  });

  it.each([
    ["fresh", () => {}],
    ["toolchain-incomplete", () => writeBinaries(["tsc", "next"])],
    ["marker-missing", () => writeBinaries()],
    ["marker-stale", () => { writeBinaries(); writeMarker(validMarker("c".repeat(64))); }],
    ["marker-corrupt", () => { writeBinaries(); writeMarker('{"schemaVersion":1,"lockfile'); }],
  ])("installs and stamps the marker for a %s worktree", async (installReason, arrange) => {
    arrange();
    const { spawnImpl, calls } = fakeSpawn({
      onSpawn: (child) => setImmediate(() => {
        fs.rmSync(path.join(worktree, "node_modules"), { recursive: true, force: true });
        writeBinaries();
        child.emit("exit", 0, null);
      }),
    });
    const killImpl = vi.fn();
    const result = await ensureWorktreeDependencies(baseOptions({ spawnImpl, killImpl }));

    expect(result).toMatchObject({ ok: true, status: "installed", installReason, reason: null, exitCode: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("npm");
    expect(calls[0].args).toEqual(installArguments());
    expect(calls[0].options).toMatchObject({ cwd: worktree, detached: true });
    expect(calls[0].options.stdio[0]).toBe("ignore");
    expect(typeof calls[0].options.stdio[1]).toBe("number");
    expect(calls[0].options.env).not.toHaveProperty("MOVIECAL_WORKER_SANDBOX");
    expect(killImpl).toHaveBeenCalledWith(4000, "SIGKILL");
    expect(readInstallMarker(worktree)).toMatchObject({ state: "valid", marker: { lockfileSha256: LOCK_SHA, headSha: HEAD } });
    expect(fs.readFileSync(path.join(logDir, "dependency-install.log"), "utf8")).toContain(`(${installReason})`);
  });

  it("refuses dirty dependency inputs before spawning npm", async () => {
    fs.writeFileSync(path.join(worktree, ".npmrc"), "registry=https://evil.example\n");
    const { spawnImpl, calls } = fakeSpawn();
    const result = await ensureWorktreeDependencies(baseOptions({ spawnImpl }));
    expect(result).toMatchObject({ ok: false, reason: "dirty-dependency-inputs", dirtyInputs: [{ path: ".npmrc", reason: "untracked" }] });
    expect(calls).toEqual([]);
  });

  it("refuses a symlinked node_modules and a missing committed lockfile", async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const missing = await ensureWorktreeDependencies(baseOptions({ spawnImpl, readCommittedInputs: committed({ "package-lock.json": null }) }));
    expect(missing).toMatchObject({ ok: false, reason: "missing-lockfile" });
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(worktree, "node_modules"));
    const unsafe = await ensureWorktreeDependencies(baseOptions({ spawnImpl }));
    expect(unsafe).toMatchObject({ ok: false, reason: "unsafe-node-modules" });
    expect(calls).toEqual([]);
  });

  it("returns a structured failure when HEAD cannot be read", async () => {
    const result = await ensureWorktreeDependencies(baseOptions({ readCommittedInputs: () => { throw new Error("not a git repository"); } }));
    expect(result).toMatchObject({ ok: false, reason: "committed-inputs-unreadable" });
    expect(result.detail).toContain("not a git repository");
  });

  it("reports npm failure with its exit code and leaves no marker", async () => {
    writeBinaries();
    writeMarker(validMarker("d".repeat(64)));
    const { spawnImpl } = fakeSpawn({ onSpawn: (child) => setImmediate(() => child.emit("exit", 1, null)) });
    const result = await ensureWorktreeDependencies(baseOptions({ spawnImpl }));
    expect(result).toMatchObject({ ok: false, reason: "npm-failed", step: "ci", exitCode: 1 });
    expect(readInstallMarker(worktree)).toEqual({ state: "missing" });
  });

  it("reports a spawn error without throwing", async () => {
    const { spawnImpl } = fakeSpawn({
      onSpawn: (child) => {
        child.pid = undefined;
        setImmediate(() => child.emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" })));
      },
    });
    const result = await ensureWorktreeDependencies(baseOptions({ spawnImpl }));
    expect(result).toMatchObject({ ok: false, reason: "spawn-error" });
    expect(result.detail).toContain("ENOENT");
    const throwing = await ensureWorktreeDependencies(baseOptions({ spawnImpl: () => { throw new Error("EAGAIN"); } }));
    expect(throwing).toMatchObject({ ok: false, reason: "spawn-error" });
  });

  it("kills the process group on timeout: SIGTERM, then SIGKILL after the grace period", async () => {
    const timers = manualTimers();
    const killImpl = vi.fn();
    const processImpl = new EventEmitter();
    const { spawnImpl, calls } = fakeSpawn();
    const pending = ensureWorktreeDependencies(baseOptions({ spawnImpl, timers, killImpl, processImpl, timeoutMs: 1000, killGraceMs: 50 }));

    expect(calls).toHaveLength(1);
    expect(timers.delays()).toEqual([1000]);
    expect(processImpl.listenerCount("exit")).toBe(1);
    timers.fireNext();
    expect(killImpl.mock.calls).toEqual([[4000, "SIGTERM"]]);
    timers.fireNext();
    expect(killImpl.mock.calls).toEqual([[4000, "SIGTERM"], [4000, "SIGKILL"]]);
    calls[0].child.emit("exit", null, "SIGKILL");
    const result = await pending;

    expect(result).toMatchObject({ ok: false, reason: "timeout", signal: "SIGKILL" });
    expect(result.detail).toContain("process group was killed");
    expect(timers.delays()).toEqual([]);
    expect(processImpl.listenerCount("exit")).toBe(0);
    expect(processImpl.listenerCount("SIGTERM")).toBe(0);
  });

  it("gives up waiting after SIGKILL when the child never reports exit", async () => {
    const timers = manualTimers();
    const { spawnImpl } = fakeSpawn();
    const pending = ensureWorktreeDependencies(baseOptions({ spawnImpl, timers, timeoutMs: 1000, killGraceMs: 50 }));
    timers.fireNext();
    timers.fireNext();
    timers.fireNext();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(result.detail).toContain("exit was not confirmed");
  });

  it("uses a ten-minute default timeout", async () => {
    expect(DEFAULT_INSTALL_TIMEOUT_MS).toBe(600_000);
    const timers = manualTimers();
    const { spawnImpl, calls } = fakeSpawn();
    const pending = ensureWorktreeDependencies(baseOptions({ spawnImpl, timers, timeoutMs: undefined }));
    expect(timers.delays()).toEqual([600_000]);
    calls[0].child.emit("exit", 1, null);
    await pending;
  });

  it("runs allowlisted lifecycle scripts only through a separate rebuild step", async () => {
    const { spawnImpl, calls } = fakeSpawn({
      onSpawn: (child, args) => setImmediate(() => {
        if (args[0] === "ci") writeBinaries();
        child.emit("exit", 0, null);
      }),
    });
    const result = await ensureWorktreeDependencies(baseOptions({ spawnImpl, scriptAllowlist: ["esbuild"] }));
    expect(result).toMatchObject({ ok: true, status: "installed" });
    expect(calls.map((call) => call.args[0])).toEqual(["ci", "rebuild"]);
    expect(calls[1].args.at(-1)).toBe("esbuild");
  });

  it("fails when npm succeeds but the toolchain is still incomplete", async () => {
    const { spawnImpl } = fakeSpawn({ onSpawn: (child) => setImmediate(() => { writeBinaries(["tsc", "next"]); child.emit("exit", 0, null); }) });
    const result = await ensureWorktreeDependencies(baseOptions({ spawnImpl }));
    expect(result).toMatchObject({ ok: false, reason: "toolchain-incomplete-after-install", missingBinaries: ["vitest"] });
    expect(readInstallMarker(worktree)).toEqual({ state: "missing" });
  });

  it("does not spawn npm when the install log cannot be opened", async () => {
    fs.writeFileSync(path.join(root, "not-a-dir"), "");
    const { spawnImpl, calls } = fakeSpawn();
    const result = await ensureWorktreeDependencies(baseOptions({ spawnImpl, logDir: path.join(root, "not-a-dir", "logs") }));
    expect(result).toMatchObject({ ok: false, reason: "log-unavailable" });
    expect(calls).toEqual([]);
  });

  it("converts an unexpected filesystem error into a not-ok result", async () => {
    const fsImpl = { ...fs, lstatSync: () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } };
    const result = await ensureWorktreeDependencies(baseOptions({ fsImpl }));
    expect(result).toMatchObject({ ok: false, reason: "unexpected-error" });
  });
});

describe("guardParentExit", () => {
  it("kills the group on parent exit and re-raises an otherwise unhandled signal", () => {
    const processImpl = Object.assign(new EventEmitter(), { pid: 99, kill: vi.fn() });
    const killImpl = vi.fn();
    guardParentExit(123, { processImpl, killImpl });
    processImpl.emit("SIGTERM");
    expect(killImpl).toHaveBeenCalledWith(123, "SIGKILL");
    expect(processImpl.kill).toHaveBeenCalledWith(99, "SIGTERM");
    expect(processImpl.listenerCount("exit")).toBe(0);
  });

  it("leaves signal handling to the dispatcher's own handler when one exists", () => {
    const processImpl = Object.assign(new EventEmitter(), { pid: 99, kill: vi.fn() });
    processImpl.on("SIGINT", () => {});
    const killImpl = vi.fn();
    const release = guardParentExit(123, { processImpl, killImpl });
    processImpl.emit("exit");
    expect(killImpl).toHaveBeenCalledWith(123, "SIGKILL");
    release();
    processImpl.emit("SIGINT");
    expect(processImpl.kill).not.toHaveBeenCalled();
    expect(processImpl.listenerCount("SIGINT")).toBe(1);
  });
});

describe("record and blocker rendering", () => {
  it("writes the result to dependency-install.json", () => {
    const file = writeDependencyInstallRecord(logDir, { ok: true, status: "current" }, { now: () => new Date("2026-09-28T12:00:00Z") });
    expect(file).toBe(path.join(logDir, DEPENDENCY_INSTALL_RECORD));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ok: true, status: "current", recordedAt: "2026-09-28T12:00:00.000Z" });
  });

  it("renders nothing for success and a precise section for a failure", async () => {
    expect(renderDependencyInstallBlocker({ ok: true })).toBeNull();
    fs.writeFileSync(path.join(worktree, "package.json"), '{"name":"changed"}\n');
    const dirty = await ensureWorktreeDependencies(baseOptions());
    const section = renderDependencyInstallBlocker(dirty);
    expect(section).toContain("### Dependency install blocked: `dirty-dependency-inputs`");
    expect(section).toContain("Commit or discard");
    expect(section).toContain("`package.json` (modified)");
    expect(section).toContain(`\`${HEAD}\``);
    expect(section).toContain(`sha256 \`${LOCK_SHA}\``);

    fs.writeFileSync(path.join(worktree, "package.json"), PACKAGE_JSON);
    const { spawnImpl } = fakeSpawn({ onSpawn: (child) => setImmediate(() => child.emit("exit", 1, null)) });
    const failed = renderDependencyInstallBlocker(await ensureWorktreeDependencies(baseOptions({ spawnImpl })));
    expect(failed).toContain("`npm-failed`");
    expect(failed).toContain("`npm ci --ignore-scripts --userconfig=/dev/null");
    expect(failed).toContain("- Exit code: `1`");
    expect(failed).toContain(`\`${path.join(logDir, "dependency-install.log")}\``);
  });
});
