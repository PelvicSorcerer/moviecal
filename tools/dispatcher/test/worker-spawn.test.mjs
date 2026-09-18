import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { redactWorkerOutput, spawnWorker, tailLogs, withCodexGitMetadataDirectories } from "../src/worker-spawn.mjs";

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

  it("records the detached process-group leader before writing the brief (MOV-254)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    let capturedChild;
    let writtenWhenRecorded;
    let recorded;
    const spawnImpl = () => {
      capturedChild = fakeChildProcess({ exitCode: 0 });
      capturedChild.pid = 4545;
      return capturedChild;
    };

    await spawnWorker({
      invocation: { command: "claude", args: ["-p"] },
      cwd: "/tmp/some-worktree",
      brief: "brief",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
      killGraceMs: 0,
      killImpl: () => {},
      onSpawn: (worker) => {
        recorded = worker;
        writtenWhenRecorded = capturedChild.getWritten();
      },
    });

    expect(recorded).toEqual({ pid: 4545 });
    expect(writtenWhenRecorded).toBe("");
  });

  it("wraps both adapters in the shared sandbox and strips worker credentials", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const originalToken = process.env.GH_TOKEN;
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    // `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not credential-shaped, so
    // sanitizedWorkerEnvironment() copies it straight through from the parent
    // and only *adds* it for `claude`. The Codex assertion below therefore
    // depends on it being absent from this process -- which it is not when the
    // suite itself runs inside a dispatcher-spawned Claude worker, since
    // worker-guard.mjs sets exactly this variable (see
    // docs/operators/local-execution.md §Security model). Control it here the
    // same way the two credentials above are controlled, so the assertion
    // tests sanitizedWorkerEnvironment rather than the ambient environment.
    const originalScrub = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
    delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
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
      if (originalScrub == null) delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
      else process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = originalScrub;
    }
    for (const [index, command] of ["claude", "codex"].entries()) {
      expect(calls[index].command).toBe("/usr/bin/sandbox-exec");
      expect(calls[index].args).toContain(command);
      expect(calls[index].opts.env).not.toHaveProperty("GH_TOKEN");
      expect(fs.readFileSync(path.join(tmpDir, command, "worker-sandbox.sb"), "utf8")).toContain("deny process-exec");
    }
    expect(calls[0].opts.env).toMatchObject({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(calls[0].opts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(calls[1].opts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(calls[1].opts.env).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
  });

  it("gives only Codex linked-worktree metadata while both adapters retain sibling-source isolation", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-spawn-"));
    const calls = [];
    const gitMetadataPaths = ["/repo/.git/worktrees/issue", "/repo/.git"];
    const protectedRepositoryPaths = ["/repo/main"];
    const protectedRepositoryReadRules = [["subpath", "/repo/main/src"], ["literal", "/repo/main/.env.local"]];
    for (const [worker, args] of [
      ["claude", ["-p"]],
      ["codex", ["--sandbox", "workspace-write", "exec", "--json"]],
    ]) {
      await spawnWorker({
        invocation: { command: worker, args },
        cwd: "/repo/worktree",
        brief: "brief",
        logDir: path.join(tmpDir, worker),
        spawnImpl: (command, actualArgs, opts) => {
          calls.push({ worker, command, args: actualArgs, opts });
          return fakeChildProcess({ exitCode: 0 });
        },
        securityContext: { mode: "implementation" },
        platform: "darwin",
        repositoryGuardPathsFn: () => ({ protectedRepositoryPaths, protectedRepositoryReadRules, gitMetadataPaths }),
      });
      const profile = fs.readFileSync(path.join(tmpDir, worker, "worker-sandbox.sb"), "utf8");
      expect(profile).toContain('(deny file-read* (subpath "/repo/main/src"))');
      expect(profile).toContain('(deny file-read* (literal "/repo/main/.env.local"))');
      expect(profile).not.toContain('(deny file-read* (subpath "/repo/main"))');
      expect(profile).toContain('(deny file-write* (subpath "/repo/main"))');
      expect(profile).toContain('(deny process-exec (literal "/usr/bin/git"))');
      for (const metadataPath of gitMetadataPaths) {
        expect(profile).toContain(`(deny file-write* (subpath \"${metadataPath}\"))`);
      }
    }
    expect(calls[0].args).not.toContain("--add-dir");
    expect(calls[1].args).toEqual([
      "-f", path.join(tmpDir, "codex", "worker-sandbox.sb"), "codex",
      "--sandbox", "workspace-write",
      "--add-dir", "/repo/.git/worktrees/issue",
      "--add-dir", "/repo/.git",
      "exec", "--json",
    ]);
  });

  it("adds metadata directories only to a valid Codex invocation", () => {
    const invocation = { command: "codex", args: ["--sandbox", "workspace-write", "exec"] };
    expect(withCodexGitMetadataDirectories(invocation, ["/repo/.git"])).toEqual({
      command: "codex",
      args: ["--sandbox", "workspace-write", "--add-dir", "/repo/.git", "exec"],
    });
    expect(withCodexGitMetadataDirectories({ command: "claude", args: ["-p"] }, ["/repo/.git"])).toEqual({ command: "claude", args: ["-p"] });
    expect(() => withCodexGitMetadataDirectories({ command: "codex", args: [] }, ["/repo/.git"])).toThrow(/include exec/);
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

  // MOV-182: a real worker transcript line is one JSON event, so a literal
  // quote in source text the worker echoed back (e.g. via Read) appears
  // JSON-escaped as a literal backslash followed by a literal quote — two
  // characters, not one real newline or an actual unescaped quote.
  it("does not redact a credential-labeled word fused into a hyphenated identifier (MOV-181 false positive)", () => {
    // Reproduces the exact transcript line that broke MOV-181's first
    // dispatch: preflight.mjs's own source contains `.startsWith("needs-secret:")`,
    // which a worker's Read tool echoes back JSON-encoded (the closing quote
    // escaped as \").
    const line = String.raw`{"content":".startsWith(\"needs-secret:\"));"}`;
    expect(redactWorkerOutput(line, { env: {} })).toBe(line);
  });

  it("does not let a matched label's value consume a backslash escaping the next quote", () => {
    // A synthetic worst case: a genuine label match whose value is
    // immediately followed by an escaped quote, with nothing but the
    // escaping backslash between them. There's no real value content to
    // redact here, but the fix must leave the backslash intact rather than
    // consuming it into the match and corrupting the surrounding JSON.
    const line = String.raw`{"x":"SECRET:\"trailing"}`;
    const output = redactWorkerOutput(line, { env: {} });
    expect(output).toBe(line);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("still redacts a genuine standalone credential-labeled value", () => {
    expect(redactWorkerOutput("SECRET: ghp_realtoken1234567890abcd", { env: {} })).toBe("SECRET: [REDACTED]");
    // Deliberately not shaped like a real key prefix (e.g. "sk-...") so this
    // fixture doesn't itself trip CI's separate secret-shape scanner.
    expect(redactWorkerOutput("API_KEY=totally-fake-test-value-not-real", { env: {} })).toBe("API_KEY=[REDACTED]");
  });
});

/**
 * A steering-test fixture with manual control over stdout emission and
 * process close, unlike fakeChildProcess() above (which auto-closes on a
 * fixed timer) -- steering tests need to trigger a turn-completion line and a
 * close event at chosen points, independent of each other.
 */
function fakeSteeringChildProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let written = "";
  let ended = false;
  let closed = false;
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      written += chunk.toString();
      cb();
    },
  });
  const originalEnd = child.stdin.end.bind(child.stdin);
  child.stdin.end = (...args) => {
    ended = true;
    return originalEnd(...args);
  };
  child.getWritten = () => written;
  child.stdinEnded = () => ended;
  child.emitTurnComplete = () => child.stdout.write(`${JSON.stringify({ type: "result" })}\n`);
  child.emitClose = (code = 0) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  };
  return child;
}

describe("spawnWorker — steering (MOV-214/215)", () => {
  let tmpDir;
  let activeChild;
  let activePromise;

  afterEach(async () => {
    activeChild?.emitClose();
    await activePromise;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    activeChild = undefined;
    activePromise = undefined;
  });

  function spawnSteering(overrides = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-steering-"));
    let capturedChild;
    const spawnImpl = () => {
      capturedChild = fakeSteeringChildProcess();
      return capturedChild;
    };
    const result = spawnWorker({
      invocation: { command: "claude", args: ["-p", "--input-format", "stream-json"] },
      cwd: "/tmp/some-worktree",
      brief: "the brief text",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
      steering: true,
      ...overrides,
    });
    activeChild = capturedChild;
    activePromise = result.promise;
    return { result, getChild: () => capturedChild };
  }

  it("returns {promise, writeTurn, requestClose, nextTurnBoundary} instead of a bare Promise", () => {
    const { result } = spawnSteering();
    expect(result).toHaveProperty("promise");
    expect(typeof result.writeTurn).toBe("function");
    expect(typeof result.requestClose).toBe("function");
    expect(typeof result.nextTurnBoundary).toBe("function");
    expect(result.promise).toBeInstanceOf(Promise);
  });

  it("sends the initial brief as a stream-json user-turn frame, and leaves stdin open", async () => {
    const { getChild } = spawnSteering();
    await new Promise((resolve) => setImmediate(resolve));
    const child = getChild();
    const parsed = JSON.parse(child.getWritten().trim());
    expect(parsed).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "the brief text" }] } });
    expect(child.stdinEnded()).toBe(false);
  });

  it("resolves nextTurnBoundary() when the worker emits a result line", async () => {
    const { result, getChild } = spawnSteering();
    const boundaryPromise = result.nextTurnBoundary();
    getChild().emitTurnComplete();
    await expect(boundaryPromise).resolves.toEqual({ ended: false });
  });

  it("resolves a turn boundary observed before nextTurnBoundary() was even called", async () => {
    const { result, getChild } = spawnSteering();
    getChild().emitTurnComplete();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(result.nextTurnBoundary()).resolves.toEqual({ ended: false });
  });

  it("writeTurn writes a new stream-json frame without closing stdin", async () => {
    const { result, getChild } = spawnSteering();
    await new Promise((resolve) => setImmediate(resolve));
    const child = getChild();
    child.getWritten(); // drain isn't needed; just re-read after
    result.writeTurn("also update the docs");
    const lines = child.getWritten().trim().split("\n");
    expect(JSON.parse(lines.at(-1))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "also update the docs" }] },
    });
    expect(child.stdinEnded()).toBe(false);
  });

  it("requestClose ends stdin", async () => {
    const { result, getChild } = spawnSteering();
    await new Promise((resolve) => setImmediate(resolve));
    result.requestClose();
    expect(getChild().stdinEnded()).toBe(true);
  });

  it("resolves nextTurnBoundary() with ended:true once the process has already closed", async () => {
    const { result, getChild } = spawnSteering();
    getChild().emitClose(0);
    await result.promise;
    await expect(result.nextTurnBoundary()).resolves.toEqual({ ended: true });
  });

  it("resolves a pending nextTurnBoundary() with ended:true if the process closes first", async () => {
    const { result, getChild } = spawnSteering();
    const boundaryPromise = result.nextTurnBoundary();
    getChild().emitClose(0);
    await expect(boundaryPromise).resolves.toEqual({ ended: true });
  });

  it("writeTurn is a safe no-op once the process has exited (never throws)", async () => {
    const { result, getChild } = spawnSteering();
    getChild().emitClose(0);
    await result.promise;
    expect(() => result.writeTurn("too late")).not.toThrow();
  });

  it("without the steering flag, behavior is byte-for-byte today's: bare Promise, stdin closed after the brief", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-worker-steering-off-"));
    let capturedChild;
    const spawnImpl = () => {
      capturedChild = fakeChildProcess({ exitCode: 0 });
      return capturedChild;
    };
    const result = spawnWorker({
      invocation: { command: "claude", args: ["-p"] },
      cwd: "/tmp/some-worktree",
      brief: "the brief text",
      logDir: path.join(tmpDir, "run"),
      spawnImpl,
    });
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(capturedChild.getWritten()).toBe("the brief text");
  });
});
