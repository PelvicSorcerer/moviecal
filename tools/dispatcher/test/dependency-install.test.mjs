import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPENDENCY_INPUT_FILES,
  INSTALL_ARGS,
  INSTALL_MARKER,
  INSTALL_SCRIPT_ALLOWLIST,
  TOOLCHAIN_BINARIES,
  dependencyInstallBlockerSections,
  dependencyInstallEnvironment,
  prepareWorktreeDependencies,
  toolchainStatus,
  writeDependencyInstallManifest,
} from "../src/dependency-install.mjs";
import { buildWorkerSandboxProfile } from "../src/worker-guard.mjs";

const LOCKFILE = '{"name":"fixture","lockfileVersion":3}\n';
const LOCK_SHA = createHash("sha256").update(LOCKFILE).digest("hex");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mov410-unit-"));
  roots.push(root);
  const worktree = path.join(root, "wt");
  const logDir = path.join(root, "logs");
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, "package-lock.json"), LOCKFILE);
  return { root, worktree, logDir };
}

// Stand-in for the dispatcher's trusted Git reads.
function fakeGit({ drift = "" } = {}) {
  return vi.fn((args) => {
    if (args[0] === "rev-parse") return `${COMMIT}\n`;
    if (args[0] === "show") return LOCKFILE;
    if (args[0] === "status") return drift;
    throw new Error(`unexpected git ${args.join(" ")}`);
  });
}

function writeBins(worktree, bins = TOOLCHAIN_BINARIES) {
  const bin = path.join(worktree, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of bins) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n");
}

// A fake child process: optional side effect (the "install"), then close.
function fakeSpawn({ exitCode = 0, output = "", effect = () => {} } = {}) {
  return vi.fn((_command, args, opts) => {
    const child = new EventEmitter();
    child.pid = 999999;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      effect(args, opts);
      child.stdout.end(output);
      child.stderr.end();
      child.emit("close", exitCode, null);
    });
    return child;
  });
}

describe("install policy (MOV-410)", () => {
  it("uses npm ci with install scripts disabled and no user npmrc, never npm install", () => {
    expect(INSTALL_ARGS[0]).toBe("ci");
    expect(INSTALL_ARGS).toContain("--ignore-scripts");
    expect(INSTALL_ARGS).toContain("--userconfig=/dev/null");
    expect(INSTALL_ARGS).not.toContain("install");
  });

  it("allowlists no install scripts: none is needed for the toolchain", () => {
    expect(INSTALL_SCRIPT_ALLOWLIST).toEqual([]);
    expect(Object.isFrozen(INSTALL_SCRIPT_ALLOWLIST)).toBe(true);
  });

  it("checks every binary npm run verify needs", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts.typecheck).toMatch(/^tsc\b/);
    expect(packageJson.scripts.build).toMatch(/^next\b/);
    expect(packageJson.scripts["lane:unit"]).toMatch(/^vitest\b/);
    expect(TOOLCHAIN_BINARIES).toEqual(["tsc", "next", "vitest"]);
    expect(DEPENDENCY_INPUT_FILES).toEqual(["package.json", "package-lock.json", ".npmrc"]);
  });
});

describe("dependencyInstallEnvironment (MOV-410)", () => {
  const source = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/Users/fixture",
    GITHUB_TOKEN: "ghp_fixture",
    GH_TOKEN: "ghp_fixture",
    LINEAR_API_KEY: "lin_api_fixture",
    LINEAR_APP_CLIENT_SECRET: "secret",
    ANTHROPIC_API_KEY: "sk-ant-fixture",
    ANTHROPIC_AUTH_TOKEN: "fixture",
    CLAUDE_CODE_OAUTH_TOKEN: "fixture",
    OPENAI_API_KEY: "sk-fixture",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    npm_config__authToken: "npm-token",
    NPM_CONFIG_REGISTRY: "https://mirror.example",
    npm_config_ignore_scripts: "false",
    MOVIECAL_WORKER_SANDBOX: "1",
  };

  it("carries the worker credential scrub and no provider, dispatcher, Git, or npm credentials", () => {
    const env = dependencyInstallEnvironment(source);
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "LINEAR_API_KEY", "LINEAR_APP_CLIENT_SECRET", "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "SSH_AUTH_SOCK",
      "npm_config__authToken", "NPM_CONFIG_REGISTRY", "npm_config_ignore_scripts"]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env).toMatchObject({
      PATH: source.PATH, HOME: source.HOME,
      GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(env.GH_CONFIG_DIR).toMatch(/moviecal-worker-no-gh-auth$/);
    expect(Object.values(env)).not.toContain("ghp_fixture");
  });

  it("does not claim to be inside the worker sandbox, because it is not", () => {
    expect(dependencyInstallEnvironment(source)).not.toHaveProperty("MOVIECAL_WORKER_SANDBOX");
  });
});

describe("toolchainStatus (MOV-410)", () => {
  it("reports an absent node_modules as incomplete", () => {
    const { worktree } = fixture();
    expect(toolchainStatus(worktree, { lockfileSha256: LOCK_SHA })).toMatchObject({ complete: false, unsafe: false, reason: "node_modules is absent" });
  });

  it("detects the MOV-331 partial install: populated node_modules, missing .bin/vitest", () => {
    const { worktree } = fixture();
    for (const pkg of ["next", "react", "typescript", "vitest"]) fs.mkdirSync(path.join(worktree, "node_modules", pkg), { recursive: true });
    writeBins(worktree, ["tsc", "next"]);
    expect(toolchainStatus(worktree, { lockfileSha256: LOCK_SHA })).toMatchObject({ complete: false, unsafe: false, missing: ["vitest"] });
  });

  it("treats a dangling binary symlink as missing", () => {
    const { worktree } = fixture();
    writeBins(worktree, ["tsc", "next"]);
    fs.symlinkSync("../vitest/vitest.mjs", path.join(worktree, "node_modules", ".bin", "vitest"));
    expect(toolchainStatus(worktree, { lockfileSha256: LOCK_SHA }).missing).toEqual(["vitest"]);
  });

  it("refuses a symlinked node_modules as unsafe to install over", () => {
    const { root, worktree } = fixture();
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(worktree, "node_modules"));
    expect(toolchainStatus(worktree, { lockfileSha256: LOCK_SHA })).toMatchObject({ complete: false, unsafe: true });
  });

  it("requires a dispatcher marker for the same lockfile, not just binaries", () => {
    const { worktree } = fixture();
    writeBins(worktree);
    expect(toolchainStatus(worktree, { lockfileSha256: LOCK_SHA })).toMatchObject({ complete: false, reason: "node_modules was not installed by the dispatcher" });
    fs.writeFileSync(path.join(worktree, INSTALL_MARKER), JSON.stringify({ lockfileSha256: "other" }));
    expect(toolchainStatus(worktree, { lockfileSha256: LOCK_SHA })).toMatchObject({ complete: false, reason: "node_modules was installed from a different lockfile" });
    fs.writeFileSync(path.join(worktree, INSTALL_MARKER), JSON.stringify({ lockfileSha256: LOCK_SHA }));
    expect(toolchainStatus(worktree, { lockfileSha256: LOCK_SHA })).toMatchObject({ complete: true });
  });
});

describe("prepareWorktreeDependencies (MOV-410)", () => {
  it("installs a fresh worktree with npm ci, the scrubbed environment, and records it", async () => {
    const { worktree, logDir } = fixture();
    const spawnImpl = fakeSpawn({ output: "added 460 packages\n", effect: () => writeBins(worktree) });

    const record = await prepareWorktreeDependencies({
      worktreePath: worktree, logDir, git: fakeGit(), spawnImpl,
      env: { PATH: "/usr/bin", HOME: "/Users/fixture", GITHUB_TOKEN: "ghp_secret", MOVIECAL_WORKER_SANDBOX: "1" },
    });

    expect(record).toMatchObject({
      ok: true, status: "installed", reason: "node_modules is absent",
      origin: "dispatcher", workerAction: false, verificationEvidence: false,
      command: "npm", args: [...INSTALL_ARGS], exitCode: 0, commit: COMMIT, lockfileSha256: LOCK_SHA,
      installScripts: { policy: "ignore-scripts", allowlist: [], rebuilds: [] },
      toolchain: { required: [...TOOLCHAIN_BINARIES], missingAfter: [] },
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, args, opts] = spawnImpl.mock.calls[0];
    expect(command).toBe("npm");
    expect(args).toEqual([...INSTALL_ARGS]);
    expect(opts.cwd).toBe(worktree);
    expect(opts.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(opts.env).not.toHaveProperty("MOVIECAL_WORKER_SANDBOX");
    expect(record.environmentKeys).not.toContain("GITHUB_TOKEN");
    expect(JSON.parse(fs.readFileSync(path.join(worktree, INSTALL_MARKER), "utf8"))).toMatchObject({ lockfileSha256: LOCK_SHA, commit: COMMIT });
    expect(JSON.parse(fs.readFileSync(path.join(logDir, "dependency-install.json"), "utf8"))).toMatchObject({ status: "installed" });
    expect(fs.readFileSync(path.join(logDir, "dependency-install.log"), "utf8")).toContain("added 460 packages");
    // Never the worker transcript the audit and verification evidence read.
    expect(fs.existsSync(path.join(logDir, "stdout.log"))).toBe(false);
  });

  it("repairs a partial node_modules by re-running npm ci", async () => {
    const { worktree, logDir } = fixture();
    writeBins(worktree, ["tsc"]);
    const spawnImpl = fakeSpawn({ effect: () => writeBins(worktree) });
    const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git: fakeGit(), spawnImpl });
    expect(record).toMatchObject({ ok: true, status: "installed" });
    expect(record.reason).toMatch(/missing from node_modules\/\.bin: next, vitest/);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("does not run npm when this lockfile's dispatcher install is already complete", async () => {
    const { worktree, logDir } = fixture();
    writeBins(worktree);
    fs.writeFileSync(path.join(worktree, INSTALL_MARKER), JSON.stringify({ lockfileSha256: LOCK_SHA }));
    const spawnImpl = fakeSpawn();
    const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git: fakeGit(), spawnImpl });
    expect(record).toMatchObject({ ok: true, status: "already-prepared", command: null, args: [], lockfileSha256: LOCK_SHA });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("fails closed with the npm error when the install fails", async () => {
    const { worktree, logDir } = fixture();
    const spawnImpl = fakeSpawn({ exitCode: 1, output: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/next failed\n" });
    const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git: fakeGit(), spawnImpl });
    expect(record).toMatchObject({ ok: false, status: "failed", exitCode: 1 });
    expect(record.reason).toBe(`npm ${INSTALL_ARGS.join(" ")} exited with code 1`);
    expect(record.outputTail).toContain("ENOTFOUND");
    expect(fs.existsSync(path.join(worktree, INSTALL_MARKER))).toBe(false);
  });

  it("fails closed when npm exits 0 but the toolchain is still incomplete", async () => {
    const { worktree, logDir } = fixture();
    const spawnImpl = fakeSpawn({ effect: () => writeBins(worktree, ["tsc", "next"]) });
    const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git: fakeGit(), spawnImpl });
    expect(record.ok).toBe(false);
    expect(record.reason).toMatch(/exited 0 but the toolchain is still incomplete: .*vitest/);
    expect(fs.existsSync(path.join(worktree, INSTALL_MARKER))).toBe(false);
  });

  it("refuses to install from dependency inputs that differ from HEAD", async () => {
    const { worktree, logDir } = fixture();
    const spawnImpl = fakeSpawn();
    const git = fakeGit({ drift: " M package-lock.json\n?? .npmrc\n" });
    const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git, spawnImpl });
    expect(record.ok).toBe(false);
    expect(record.reason).toMatch(/dependency inputs differ from the committed HEAD .*M package-lock\.json; \?\? \.npmrc/);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(git).toHaveBeenCalledWith(["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...DEPENDENCY_INPUT_FILES], { cwd: worktree });
  });

  it("refuses a symlinked node_modules without running npm", async () => {
    const { root, worktree, logDir } = fixture();
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(worktree, "node_modules"));
    const spawnImpl = fakeSpawn();
    const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git: fakeGit(), spawnImpl });
    expect(record.reason).toMatch(/refusing to run npm ci: node_modules is not a real directory/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the committed lockfile cannot be read", async () => {
    const { worktree, logDir } = fixture();
    const git = vi.fn(() => { throw new Error("fatal: not a git repository"); });
    const spawnImpl = fakeSpawn();
    const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git, spawnImpl });
    expect(record.reason).toMatch(/could not read the committed package-lock\.json.*not a git repository/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("kills and fails an install that exceeds its timeout", async () => {
    const { worktree, logDir } = fixture();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      child.pid = 424242;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      kill.mockImplementation(() => { setImmediate(() => child.emit("close", null, "SIGKILL")); return true; });
      return child;
    });
    try {
      const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git: fakeGit(), spawnImpl, timeoutMs: 5 });
      expect(record.ok).toBe(false);
      expect(record.reason).toMatch(/did not finish within 5ms and was killed/);
      expect(kill).toHaveBeenCalledWith(-424242, "SIGKILL");
    } finally {
      kill.mockRestore();
    }
  });

  it("runs only allowlisted install scripts, one explicit npm rebuild each", async () => {
    const { worktree, logDir } = fixture();
    const spawnImpl = fakeSpawn({ effect: (args) => { if (args[0] === "ci") writeBins(worktree); } });
    const record = await prepareWorktreeDependencies({ worktreePath: worktree, logDir, git: fakeGit(), spawnImpl, allowlist: ["fixture-native"] });
    expect(record.ok).toBe(true);
    expect(spawnImpl.mock.calls.map(([, args]) => args)).toEqual([
      [...INSTALL_ARGS],
      ["rebuild", "fixture-native", "--foreground-scripts", "--userconfig=/dev/null"],
    ]);
    expect(record.installScripts.rebuilds).toEqual([{ package: "fixture-native", args: ["rebuild", "fixture-native", "--foreground-scripts", "--userconfig=/dev/null"], exitCode: 0 }]);
  });
});

describe("failure reporting (MOV-410)", () => {
  it("writes a no-worker manifest and a precise blocker", () => {
    const { logDir } = fixture();
    const record = { ok: false, status: "failed", reason: "npm ci exited with code 1", commit: COMMIT, lockfileSha256: LOCK_SHA, outputTail: "npm error code ENOTFOUND" };
    const manifestPath = writeDependencyInstallManifest(logDir, record);
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).toEqual({ workerStarted: false, exitCode: null, dependencyInstall: record });
    const text = dependencyInstallBlockerSections(record, logDir).join("\n");
    expect(text).toContain("Reason: npm ci exited with code 1");
    expect(text).toContain(`Lockfile SHA-256: \`${LOCK_SHA}\``);
    expect(text).toContain("npm error code ENOTFOUND");
    expect(text).toMatch(/No worker was started.*no worker-side fallback, and no sandbox profile was changed/);
  });
});

describe("worker sandbox profiles stay closed to install traffic (MOV-410)", () => {
  const networkRules = (profile) => profile.split("\n").filter((line) => /network/.test(line) && /^\(allow/.test(line));

  it.each(["implementation", "repair"])("adds no network allowance to the Claude %s profile", (mode) => {
    const profile = buildWorkerSandboxProfile({ worktreePath: "/tmp/worktree", home: "/Users/test", mode, logDir: "/tmp/logs" });
    expect(networkRules(profile)).toEqual([]);
    expect(profile).not.toMatch(/registry\.npmjs\.org/);
  });

  it.each(["implementation", "repair"])("keeps the Codex %s executor's only network rule its loopback listener", (mode) => {
    const profile = buildWorkerSandboxProfile({
      worktreePath: "/tmp/worktree", home: "/Users/test", mode, logDir: "/tmp/logs",
      networkRole: "executor", writablePaths: ["/tmp/worktree", "/tmp/executor-home"],
    });
    expect(networkRules(profile)).toEqual([
      '(allow network-bind network-inbound (require-all (local tcp (param "EXECUTOR_LISTENER")) (socket-domain AF_INET)))',
    ]);
    expect(profile).not.toContain("(allow network-outbound)");
    expect(profile).not.toMatch(/registry\.npmjs\.org/);
  });
});
