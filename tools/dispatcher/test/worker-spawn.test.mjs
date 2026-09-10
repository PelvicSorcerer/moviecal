import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { redactWorkerOutput, spawnWorker, tailLogs } from "../src/worker-spawn.mjs";

function fakeChildProcess({ exitCode = 0, stdoutText = "", stderrText = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let written = "";
  child.stdin = new Writable({
    write(chunk, enc, cb) {
      written += chunk.toString();
      cb();
    },
  });
  child.stdin.end = ((orig) =>
    function (...args) {
      orig.apply(this, args);
      return this;
    })(child.stdin.end.bind(child.stdin));

  // Simulate async process behavior: write output, then close.
  queueMicrotask(() => {
    if (stdoutText) child.stdout.write(stdoutText);
    if (stderrText) child.stderr.write(stderrText);
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", exitCode));
  });

  child.getWritten = () => written;
  return child;
}

describe("spawnWorker", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pipes the brief to the worker's stdin", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    let capturedChild;
    const spawnImpl = () => {
      capturedChild = fakeChildProcess({ exitCode: 0 });
      return capturedChild;
    };

    await spawnWorker({
      invocation: { command: "claude", args: ["-p"] },
      cwd: "/tmp/some-worktree",
      brief: "the brief text",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
    });

    expect(capturedChild.getWritten()).toBe("the brief text");
  });

  it("captures stdout/stderr to log files and writes a manifest", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const logDir = path.join(tmpDir, "run");
    const spawnImpl = () => fakeChildProcess({ exitCode: 0, stdoutText: "hello stdout", stderrText: "hello stderr" });

    const result = await spawnWorker({
      invocation: { command: "claude", args: ["-p"] },
      cwd: "/tmp/some-worktree",
      brief: "brief",
      logDir,
      spawnImpl,
    });

    expect(result.exitCode).toBe(0);
    // spawnWorker now only resolves once both log streams have finished
    // writing, so no artificial wait is needed here.
    expect(fs.readFileSync(path.join(logDir, "stdout.log"), "utf8")).toContain("hello stdout");
    expect(fs.readFileSync(path.join(logDir, "stderr.log"), "utf8")).toContain("hello stderr");
    const manifest = JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8"));
    expect(manifest.exitCode).toBe(0);
    expect(manifest.command).toBe("claude");
  });

  it("resolves with a non-zero exit code when the worker fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const spawnImpl = () => fakeChildProcess({ exitCode: 1 });

    const result = await spawnWorker({
      invocation: { command: "codex", args: ["exec"] },
      cwd: "/tmp/x",
      brief: "brief",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
    });

    expect(result.exitCode).toBe(1);
  });

  it("spawns the worker detached so it becomes its own process-group leader", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    let capturedOpts;
    const spawnImpl = (cmd, args, opts) => {
      capturedOpts = opts;
      return fakeChildProcess({ exitCode: 0 });
    };

    await spawnWorker({
      invocation: { command: "claude", args: ["-p"] },
      cwd: "/tmp/some-worktree",
      brief: "brief",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
    });

    expect(capturedOpts.detached).toBe(true);
  });

  it("wraps both adapters in the shared sandbox and strips worker credentials", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const originalToken = process.env.GH_TOKEN;
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.GH_TOKEN = "ghp_this_must_not_reach_the_worker";
    process.env.ANTHROPIC_API_KEY = "anthropic_parent_only";
    const calls = [];
    const spawnImpl = (command, args, opts) => {
      calls.push({ command, args, opts });
      return fakeChildProcess({ exitCode: 0 });
    };
    try {
      for (const command of ["claude", "codex"]) {
        await spawnWorker({
          invocation: { command, args: ["exec"] },
          cwd: "/tmp/some-worktree",
          brief: "brief",
          logDir: path.join(tmpDir, command),
          spawnImpl,
          securityContext: { mode: "implementation" },
          platform: "darwin",
          repositoryGuardPathsFn: () => ({ protectedRepositoryPaths: [], gitMetadataPaths: [] }),
        });
      }
    } finally {
      if (originalToken == null) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
      if (originalAnthropicKey == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
    for (const [index, command] of ["claude", "codex"].entries()) {
      expect(calls[index].command).toBe("/usr/bin/sandbox-exec");
      expect(calls[index].args).toContain(command);
      expect(calls[index].opts.env).not.toHaveProperty("GH_TOKEN");
      expect(fs.readFileSync(path.join(tmpDir, command, "worker-sandbox.sb"), "utf8")).toContain("deny process-exec");
    }
    expect(calls[0].opts.env).toMatchObject({
      ANTHROPIC_API_KEY: "anthropic_parent_only",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(calls[1].opts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(calls[1].opts.env).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
  });

  it("fails closed rather than spawning without the Mac safety boundary", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const spawnImpl = vi.fn();
    await expect(spawnWorker({
      invocation: { command: "codex", args: ["exec"] },
      cwd: "/tmp/some-worktree",
      brief: "brief",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
      securityContext: { mode: "repair" },
      platform: "linux",
    })).rejects.toThrow(/only supported on darwin/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("sends SIGTERM then SIGKILL to the worker's process group after it exits (MOV-137)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const signals = [];
    const killImpl = (pid, signal) => signals.push({ pid, signal });
    const spawnImpl = () => {
      const child = fakeChildProcess({ exitCode: 0 });
      child.pid = 4242;
      return child;
    };

    await spawnWorker({
      invocation: { command: "claude", args: ["-p"] },
      cwd: "/tmp/some-worktree",
      brief: "brief",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
      killGraceMs: 5,
      killImpl,
    });

    expect(signals).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("kills the worker's process group when the abort signal fires (MOV-138)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const signals = [];
    const killImpl = (pid, signal) => signals.push({ pid, signal });
    const controller = new AbortController();
    let capturedChild;
    const spawnImpl = () => {
      capturedChild = fakeChildProcess({ exitCode: 0 });
      capturedChild.pid = 4343;
      return capturedChild;
    };

    const resultPromise = spawnWorker({
      invocation: { command: "claude", args: ["-p"] },
      cwd: "/tmp/some-worktree",
      brief: "brief",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
      killGraceMs: 5,
      killImpl,
      signal: controller.signal,
    });

    // Abort before the fake child's own close event (queued via queueMicrotask
    // in fakeChildProcess) fires, simulating a still-hung worker being killed.
    controller.abort();
    await resultPromise;

    expect(signals[0]).toEqual({ pid: 4343, signal: "SIGTERM" });
    expect(signals.some((s) => s.signal === "SIGKILL")).toBe(true);
  });

  it("does not attempt to signal a process group when the child never got a pid", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const killImpl = vi.fn();
    const spawnImpl = () => fakeChildProcess({ exitCode: 0 }); // no .pid set, like the other fakes in this file

    await spawnWorker({
      invocation: { command: "claude", args: ["-p"] },
      cwd: "/tmp/some-worktree",
      brief: "brief",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
      killGraceMs: 5,
      killImpl,
    });

    expect(killImpl).not.toHaveBeenCalled();
  });

  it("reaps a real backgrounded child so it does not outlive the worker (MOV-137)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const pidFile = path.join(tmpDir, "child.pid");

    // A fake worker that backgrounds a long sleep and exits immediately —
    // exactly the failure mode from MOV-106 this issue exists to close off.
    // The background job redirects its own stdio to /dev/null, same as any
    // real daemonized process would, so it doesn't hold the parent's piped
    // stdout/stderr open (an inherited pipe fd would stall Node's own
    // ChildProcess "close" event independent of process-group reaping).
    const result = await spawnWorker({
      invocation: {
        command: "sh",
        args: ["-c", `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`],
      },
      cwd: tmpDir,
      brief: "",
      logDir: path.join(tmpDir, "run"),
      killGraceMs: 100,
    });

    expect(result.exitCode).toBe(0);
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("rejects when the spawn itself errors (e.g. binary not found)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(c, e, cb) { cb(); } });
      queueMicrotask(() => child.emit("error", new Error("ENOENT: no such binary")));
      return child;
    };

    await expect(
      spawnWorker({
        invocation: { command: "nonexistent-binary", args: [] },
        cwd: "/tmp/x",
        brief: "brief",
        logDir: path.join(tmpDir, "run"),
        spawnImpl,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("tailLogs", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty-ish string when no logs exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-taillogs-"));
    expect(tailLogs(tmpDir)).toBe("");
  });

  it("tails the last n lines of both log files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-taillogs-"));
    fs.writeFileSync(path.join(tmpDir, "stdout.log"), Array.from({ length: 100 }, (_, i) => `out-${i}`).join("\n"));
    fs.writeFileSync(path.join(tmpDir, "stderr.log"), "err-only-line");

    const tail = tailLogs(tmpDir, 5);

    expect(tail).toContain("out-99");
    expect(tail).not.toContain("out-50");
    expect(tail).toContain("err-only-line");
  });
});

describe("worker log redaction", () => {
  it("redacts exact inherited credentials and common token shapes", () => {
    const output = redactWorkerOutput(
      "GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 and exact-secret-value",
      { env: { GH_TOKEN: "exact-secret-value" } },
    );
    expect(output).not.toContain("exact-secret-value");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(output).toContain("[REDACTED]");
  });
});
