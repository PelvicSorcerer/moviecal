import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawnWorker, tailLogs } from "../src/worker-spawn.mjs";

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
