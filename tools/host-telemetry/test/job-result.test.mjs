import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupResult, parseResultLines, pickResult, readLogs, resolveJobResult } from "../src/job-result.mjs";
import { readMarkers } from "../src/markers.mjs";
import { runHook, spawnResultResolver } from "../src/runner-hook.mjs";

const RESOLVER = fileURLToPath(new URL("../bin/resolve-job-result.mjs", import.meta.url));
const HOOKS = fileURLToPath(new URL("../hooks/", import.meta.url));
const SINCE = Date.parse("2026-11-03T01:27:45Z");
const RUNNER_LINE = "[2026-11-03 01:27:48Z INFO JobDispatcher] Job ios-tests completed with result: Succeeded";
const WORKER_LINE = "[2026-11-03 01:27:46Z INFO Worker] Job ios-tests completed with result: Succeeded";

let root;
let diag;
let telemetry;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "job-result-"));
  diag = path.join(root, "_diag");
  telemetry = path.join(root, "telemetry");
  fs.mkdirSync(diag);
});

const writeLog = (name, text, mtimeMs = Date.now()) => {
  const file = path.join(diag, name);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
};
const readAll = () => readMarkers({ dir: telemetry, sinceMs: Date.now() - 600_000, untilMs: Date.now() + 600_000 });
const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForMarker(event, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = readAll().find((marker) => marker.event === event);
    if (found) return found;
    await sleepReal(100);
  }
  return undefined;
}

describe("log parsing", () => {
  it("reads timestamped result lines, oldest first, and bare lines with a null time", () => {
    const lines = parseResultLines(`noise\n${WORKER_LINE}\nJob x completed with result: Failed\r\n[2026-11-03T01:27:50.123Z INFO R] Job y completed with result: Canceled`);
    expect(lines).toEqual([
      { result: "Succeeded", atMs: Date.parse("2026-11-03T01:27:46Z") },
      { result: "Failed", atMs: null },
      { result: "Canceled", atMs: Date.parse("2026-11-03T01:27:50Z") },
    ]);
  });

  it("tolerates empty, null and garbage input", () => {
    expect(parseResultLines("")).toEqual([]);
    expect(parseResultLines(null)).toEqual([]);
    expect(parseResultLines("completed with result:\nJob completed with result: ")).toEqual([]);
  });

  it("ignores result lines stamped before the hook (earlier jobs)", () => {
    const text = "[2026-11-03 01:00:00Z INFO R] Job old completed with result: Failed\n" + RUNNER_LINE;
    expect(pickResult(text, { sinceMs: SINCE })).toBe("Succeeded");
    expect(pickResult("[2026-11-03 01:00:00Z INFO R] Job old completed with result: Failed", { sinceMs: SINCE })).toBeNull();
  });

  it("takes the last matching line and allows 2s of clock slack", () => {
    const text = "[2026-11-03 01:27:44Z INFO R] Job a completed with result: Failed\n[2026-11-03 01:27:49Z INFO R] Job b completed with result: Canceled";
    expect(pickResult(text, { sinceMs: SINCE })).toBe("Canceled");
    expect(pickResult("[2026-11-03 01:27:44Z INFO R] Job a completed with result: Failed", { sinceMs: SINCE })).toBe("Failed");
  });

  it("trusts an unstamped line only when the file was written after the hook", () => {
    const bare = "Job x completed with result: Failed";
    expect(pickResult(bare, { sinceMs: SINCE })).toBeNull();
    expect(pickResult(bare, { sinceMs: SINCE, fileMtimeMs: SINCE - 60_000 })).toBeNull();
    expect(pickResult(bare, { sinceMs: SINCE, fileMtimeMs: SINCE + 3000 })).toBe("Failed");
  });
});

describe("log discovery", () => {
  it("returns nothing for a missing directory, no logs, or no matching name", () => {
    expect(readLogs(path.join(root, "nope"), "Runner")).toEqual([]);
    expect(readLogs(diag, "Runner")).toEqual([]);
    writeLog("Other_1.log", RUNNER_LINE);
    writeLog("Runner_1.txt", RUNNER_LINE);
    expect(readLogs(diag, "Runner")).toEqual([]);
    expect(lookupResult(diag, SINCE)).toEqual({ result: null, source: null });
  });

  it("orders multiple logs newest first and skips logs older than the hook", () => {
    writeLog("Runner_old.log", "old", SINCE - 3_600_000);
    writeLog("Runner_a.log", "a", SINCE + 1000);
    writeLog("Runner_b.log", "b", SINCE + 5000);
    expect(readLogs(diag, "Runner", { sinceMs: SINCE }).map((log) => log.text)).toEqual(["b", "a"]);
  });

  it("skips a directory that looks like a log and an unreadable entry", () => {
    fs.mkdirSync(path.join(diag, "Runner_dir.log"));
    expect(readLogs(diag, "Runner")).toEqual([]);
  });

  it("reads only the tail of a huge log", () => {
    writeLog("Runner_big.log", `${"x".repeat(700 * 1024)}\n${RUNNER_LINE}\n`, SINCE + 5000);
    expect(lookupResult(diag, SINCE)).toEqual({ result: "Succeeded", source: "runner-log" });
  });

  it("prefers the Runner log, falls back to the Worker log, and uses the newest of several logs", () => {
    writeLog("Worker_1.log", WORKER_LINE.replace("Succeeded", "Failed"), SINCE + 1000);
    expect(lookupResult(diag, SINCE)).toEqual({ result: "Failed", source: "worker-log" });
    writeLog("Runner_old.log", "[2026-11-03 01:27:47Z INFO R] Job z completed with result: Canceled", SINCE + 500);
    writeLog("Runner_new.log", RUNNER_LINE, SINCE + 4000);
    expect(lookupResult(diag, SINCE)).toEqual({ result: "Succeeded", source: "runner-log" });
  });

  it("falls through a Runner log that has no result yet", () => {
    writeLog("Runner_1.log", "[2026-11-03 01:27:40Z INFO R] Starting\n", SINCE + 1000);
    writeLog("Worker_1.log", WORKER_LINE, SINCE + 1000);
    expect(lookupResult(diag, SINCE).source).toBe("worker-log");
  });
});

describe("resolveJobResult timing", () => {
  const fakeClock = () => {
    let t = 0;
    const sleeps = [];
    return { sleeps, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } };
  };

  it("waits the initial delay before the first look and stops at once when found", async () => {
    const clock = fakeClock();
    const lookup = vi.fn(() => ({ result: "Succeeded", source: "runner-log" }));
    const out = await resolveJobResult({ dir: "d", sinceMs: 0, lookup, ...clock });
    expect(clock.sleeps).toEqual([10_000]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ result: "Succeeded", source: "runner-log", attempts: 1, waitedMs: 10_000 });
  });

  it("retries while the result is missing and succeeds when it appears late", async () => {
    const clock = fakeClock();
    let calls = 0;
    const lookup = () => (++calls < 4 ? { result: null, source: null } : { result: "Failed", source: "worker-log" });
    const out = await resolveJobResult({ dir: "d", sinceMs: 0, lookup, ...clock });
    expect(out).toMatchObject({ result: "Failed", source: "worker-log", attempts: 4 });
    expect(clock.sleeps).toEqual([10_000, 2000, 2000, 2000]);
  });

  it("gives up after the bounded wait with a null result", async () => {
    const clock = fakeClock();
    const lookup = vi.fn(() => ({ result: null, source: null }));
    const out = await resolveJobResult({ dir: "d", sinceMs: 0, lookup, ...clock });
    expect(out.result).toBeNull();
    expect(out.waitedMs).toBeLessThanOrEqual(30_000);
    expect(lookup.mock.calls.length).toBeGreaterThan(1);
    expect(lookup.mock.calls.length).toBeLessThan(20);
  });

  it("does not look at all without a diag directory", async () => {
    const clock = fakeClock();
    const lookup = vi.fn();
    expect(await resolveJobResult({ dir: null, sinceMs: 0, lookup, ...clock })).toMatchObject({ result: null, attempts: 0 });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("survives a lookup that throws", async () => {
    const clock = fakeClock();
    const out = await resolveJobResult({ dir: "d", sinceMs: 0, lookup: () => { throw new Error("EIO"); }, ...clock });
    expect(out.result).toBeNull();
  });
});

describe("hook integration", () => {
  const env = () => ({
    GITHUB_RUN_ID: "555", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "ios-tests", GITHUB_WORKFLOW: "CI", GITHUB_SHA: "abc", RUNNER_NAME: "mac-1",
    MOVIECAL_TELEMETRY_DIR: telemetry, MOVIECAL_RUNNER_DIAG_DIR: diag,
  });
  const fast = { initialWaitMs: 0, intervalMs: 50, maxWaitMs: 600 };

  it("spawnResultResolver is fire-and-forget and carries identity but not the result", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    expect(spawnResultResolver({ runId: "1", job: "j", result: "x", fromDiag: "runId" }, { env: env(), now: () => 42, spawnImpl })).toBe(true);
    const [, [, payload], opts] = [null, spawnImpl.mock.calls[0][1], spawnImpl.mock.calls[0][2]];
    expect(JSON.parse(payload)).toMatchObject({ fields: { runId: "1", job: "j" }, sinceMs: 42, diagDir: diag });
    expect(JSON.parse(payload).fields).not.toHaveProperty("result");
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(child.unref).toHaveBeenCalled();
  });

  it("returns false instead of throwing when the spawn fails", () => {
    expect(spawnResultResolver({}, { env: env(), spawnImpl: () => { throw new Error("EMFILE"); } })).toBe(false);
  });

  it("job-completed returns without waiting for the result", async () => {
    const spawnImpl = vi.fn(() => ({ on() {}, unref() {} }));
    const started = Date.now();
    expect(await runHook("job-completed", { env: env(), timeoutMs: 10_000, spawnImpl })).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(readAll().map((marker) => marker.event)).toEqual(["job-completed"]);
  });

  it("job-started never starts the resolver", async () => {
    const spawnImpl = vi.fn();
    await runHook("job-started", { env: env(), timeoutMs: 10_000, spawnImpl });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("writes a job-result marker after the result lands in Runner_*.log late", async () => {
    const hookMs = Date.now();
    const stamp = new Date(hookMs + 300).toISOString().slice(0, 19).replace("T", " ");
    expect(spawnResultResolver({ runId: "555", job: "ios-tests", runner: "mac-1" }, { env: env(), now: () => hookMs, options: fast })).toBe(true);
    await sleepReal(200);
    writeLog("Runner_late.log", `[${stamp}Z INFO JobDispatcher] Job ios-tests completed with result: Failed\n`, hookMs + 300);
    const marker = await waitForMarker("job-result");
    expect(marker).toMatchObject({ source: "runner", runId: "555", job: "ios-tests", result: "Failed", resultSource: "runner-log" });
    expect(marker.attempts).toBeGreaterThan(1);
  });

  it("writes a job-result marker with a null result when no log ever has one", async () => {
    writeLog("Runner_1.log", "[2026-01-01 00:00:00Z INFO R] nothing\n");
    spawnResultResolver({ runId: "555" }, { env: env(), options: fast });
    const marker = await waitForMarker("job-result");
    expect(marker).toMatchObject({ runId: "555", result: null, resultSource: null });
  });

  it("writes a null-result marker when the diag directory does not exist", async () => {
    spawnResultResolver({ runId: "555" }, { env: { ...env(), MOVIECAL_RUNNER_DIAG_DIR: path.join(root, "gone") }, options: fast });
    expect(await waitForMarker("job-result")).toMatchObject({ result: null });
  });

  it("the resolver process exits 0 on garbage input or an unwritable telemetry dir", () => {
    expect(spawnSync(process.execPath, [RESOLVER, "not json"]).status).toBe(0);
    expect(spawnSync(process.execPath, [RESOLVER]).status).toBe(0);
    const blocker = path.join(root, "file");
    fs.writeFileSync(blocker, "x");
    const payload = JSON.stringify({ fields: {}, dir: path.join(blocker, "x"), diagDir: diag, sinceMs: 0, options: fast });
    expect(spawnSync(process.execPath, [RESOLVER, payload]).status).toBe(0);
  });

  it("the real hook script exits quickly and the resolver outlives it", async () => {
    const hookEnv = { PATH: process.env.PATH, MOVIECAL_NODE: process.execPath, ...env() };
    const started = Date.now();
    const result = spawnSync(path.join(HOOKS, "job-completed.sh"), [], { env: hookEnv, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(result.stdout).toBe("");
    // The default 10s initial wait means the marker cannot be there yet.
    expect(readAll().map((marker) => marker.event)).toEqual(["job-completed"]);
  });
});
