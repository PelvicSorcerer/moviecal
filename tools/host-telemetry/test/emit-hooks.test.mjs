import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitMarker, resetEmitWarning } from "../src/emit.mjs";
import { readMarkers } from "../src/markers.mjs";
import { buildHookFields, parseWorkerLog, runHook } from "../src/runner-hook.mjs";

const HOOKS = fileURLToPath(new URL("../hooks/", import.meta.url));
const HOOK_ENV = {
  GITHUB_RUN_ID: "123456",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_JOB: "ios-tests",
  GITHUB_WORKFLOW: "CI",
  GITHUB_SHA: "abc123",
  GITHUB_REF: "refs/heads/agent/MOV-1",
  GITHUB_REPOSITORY: "adam/moviecal",
  RUNNER_NAME: "mac-1",
};

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-emit-"));
  resetEmitWarning();
});

const readAll = () => readMarkers({ dir, sinceMs: Date.now() - 60_000, untilMs: Date.now() + 60_000 });

describe("emitMarker failure isolation", () => {
  it("writes a schema-valid marker through the detached writer", async () => {
    const ok = await emitMarker({ source: "dispatcher", event: "worker-spawned", issue: "MOV-1" }, { env: { MOVIECAL_TELEMETRY_DIR: dir }, wait: true, timeoutMs: 10_000 });
    expect(ok).toBe(true);
    expect(readAll()).toEqual([expect.objectContaining({ source: "dispatcher", event: "worker-spawned", issue: "MOV-1" })]);
  });

  it("reports an unwritable directory once and never throws", async () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    const warn = vi.fn();
    const env = { MOVIECAL_TELEMETRY_DIR: path.join(blocker, "nested") };
    expect(await emitMarker({ source: "runner", event: "a" }, { env, wait: true, timeoutMs: 10_000, warn })).toBe(false);
    expect(await emitMarker({ source: "runner", event: "b" }, { env, wait: true, timeoutMs: 10_000, warn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not block on a stalled writer and gives up after the timeout", async () => {
    const stalled = path.join(dir, "stalled.mjs");
    fs.writeFileSync(stalled, "setTimeout(() => {}, 30000);\n");
    const warn = vi.fn();
    const started = Date.now();
    const fireAndForget = emitMarker({ source: "runner", event: "a" }, { env: { MOVIECAL_TELEMETRY_DIR: dir }, writer: stalled, warn });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await fireAndForget).toBe(true);

    const waited = await emitMarker({ source: "runner", event: "b" }, { env: { MOVIECAL_TELEMETRY_DIR: dir }, writer: stalled, wait: true, timeoutMs: 200, warn });
    expect(waited).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("swallows a spawn that throws", async () => {
    const warn = vi.fn();
    const spawnImpl = () => {
      throw new Error("EMFILE");
    };
    expect(await emitMarker({ source: "runner", event: "a" }, { spawnImpl, warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EMFILE"));
  });
});

describe("runner hook fields", () => {
  it("maps the hook environment and records null for missing fields", () => {
    const fields = buildHookFields("job-started", { ...HOOK_ENV, GITHUB_REF: "" });
    expect(fields).toMatchObject({
      runId: "123456", runAttempt: "2", job: "ios-tests", workflow: "CI", sha: "abc123", ref: null, repository: "adam/moviecal", runner: "mac-1",
    });
    expect(fields).not.toHaveProperty("result");
    expect(fields).not.toHaveProperty("fromDiag");
  });

  it("falls back to the _diag Worker log for the run id and the result", () => {
    const log = [
      '[2026-11-02 10:00:00Z INFO Worker] "github": {"d": [{"k": "run_id", "v": "987654"}]}',
      "[2026-11-02 10:30:00Z INFO JobRunner] Job ios-tests completed with result: Failed",
    ].join("\n");
    const readLog = vi.fn(() => log);
    const fields = buildHookFields("job-completed", { RUNNER_TEMP: "/runner/_work/_temp" }, { readLog });
    expect(readLog).toHaveBeenCalledWith(path.join("/runner/_work/_temp", "..", "..", "_diag"));
    expect(fields).toMatchObject({ runId: "987654", result: "Failed", fromDiag: "runId,result", job: null });
  });

  it("parses the last result line and tolerates garbage", () => {
    expect(parseWorkerLog("Job a completed with result: Succeeded\nJob a completed with result: Failed")).toEqual({ runId: null, result: "Failed" });
    expect(parseWorkerLog("")).toEqual({ runId: null, result: null });
  });

  it("reads the newest Worker log from a real _diag directory", () => {
    const diag = path.join(dir, "_diag");
    fs.mkdirSync(diag);
    fs.writeFileSync(path.join(diag, "Worker_old.log"), "Job x completed with result: Failed\n");
    fs.utimesSync(path.join(diag, "Worker_old.log"), new Date(1000), new Date(1000));
    fs.writeFileSync(path.join(diag, "Worker_new.log"), "Job x completed with result: Succeeded\n");
    expect(buildHookFields("job-completed", { ...HOOK_ENV, MOVIECAL_RUNNER_DIAG_DIR: diag }).result).toBe("Succeeded");
  });

  it("writes job-started and job-completed markers that the reader accepts", async () => {
    const env = { ...HOOK_ENV, MOVIECAL_TELEMETRY_DIR: dir, GITHUB_JOB_STATUS: "success" };
    expect(await runHook("job-started", { env, timeoutMs: 10_000 })).toBe(true);
    expect(await runHook("job-completed", { env, timeoutMs: 10_000 })).toBe(true);
    const markers = readAll();
    expect(markers.map((marker) => [marker.source, marker.event])).toEqual([["runner", "job-started"], ["runner", "job-completed"]]);
    expect(markers[0]).toMatchObject({ runId: "123456", runAttempt: "2", workflow: "CI", sha: "abc123", repository: "adam/moviecal" });
    expect(markers[1].result).toBe("success");
  });
});

describe("hook scripts", () => {
  it("exit 0 with null fields and an unwritable directory", () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    for (const script of ["job-started.mjs", "job-completed.mjs", "job-started.sh"]) {
      const result = spawnSync(path.join(HOOKS, script), [], {
        env: { PATH: process.env.PATH, MOVIECAL_TELEMETRY_DIR: path.join(blocker, "x") }, encoding: "utf8",
      });
      expect(result.status, script).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("write a marker with nulls when run with an empty hook environment", () => {
    const result = spawnSync(path.join(HOOKS, "job-completed.sh"), [], { env: { PATH: process.env.PATH, MOVIECAL_TELEMETRY_DIR: dir, MOVIECAL_NODE: process.execPath } });
    expect(result.status).toBe(0);
    expect(readAll()).toEqual([expect.objectContaining({ source: "runner", event: "job-completed", runId: null, job: null, result: null })]);
  });
});
