import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkGithubCliAuth,
  classifyGithubAuthFailure,
  DispatcherLaunchHealthStore,
} from "../src/launch-health.mjs";

describe("GitHub CLI launch health (MOV-287)", () => {
  it("accepts a healthy non-interactive gh auth check", () => {
    const run = (...args) => {
      expect(args).toEqual(["gh", ["auth", "status"], { encoding: "utf8", stdio: "pipe" }]);
    };
    expect(checkGithubCliAuth({ run })).toEqual({ ok: true, kind: "ok", diagnostic: null });
  });

  it("classifies unavailable credentials without retaining gh output", () => {
    const result = checkGithubCliAuth({
      run: () => {
        const error = new Error("command failed");
        error.stderr = "HTTP 401: Requires authentication\\nBearer should-never-appear";
        throw error;
      },
    });
    expect(result).toMatchObject({ ok: false, kind: "gh-auth-unavailable" });
    expect(result.diagnostic).toMatch(/gh auth login/);
    expect(JSON.stringify(result)).not.toContain("should-never-appear");
  });

  it("separates a missing launchd PATH entry from an auth failure", () => {
    expect(classifyGithubAuthFailure({ code: "ENOENT", message: "spawn gh ENOENT" })).toMatchObject({
      kind: "gh-not-found",
      diagnostic: expect.stringContaining("PATH"),
    });
  });
});

describe("DispatcherLaunchHealthStore", () => {
  let root;
  let store;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-launch-health-"));
    store = new DispatcherLaunchHealthStore(path.join(root, "dispatcher-launch-health.json"));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("marks a first poll healthy durably", () => {
    store.beginFirstPoll({ now: new Date("2026-09-22T00:00:00Z"), timeoutMs: 120_000 });
    store.completeFirstPoll({ now: new Date("2026-09-22T00:00:10Z") });
    expect(new DispatcherLaunchHealthStore(store.statePath).status()).toMatchObject({
      status: "healthy",
      firstPollCompletedAt: "2026-09-22T00:00:10.000Z",
    });
  });

  it("makes a hung first poll visible as overdue without mutating the record", () => {
    store.beginFirstPoll({ now: new Date("2026-09-22T00:00:00Z"), timeoutMs: 120_000 });
    expect(store.status({ now: new Date("2026-09-22T00:02:01Z") })).toMatchObject({
      status: "overdue",
      diagnostic: expect.stringContaining("did not record"),
    });
    expect(store.load().status).toBe("starting");
  });

  it("retains only a classified startup failure", () => {
    store.beginFirstPoll();
    store.failFirstPoll({ kind: "gh-auth-unavailable", diagnostic: "repair gh auth" });
    expect(store.status()).toMatchObject({
      status: "failed",
      failureKind: "gh-auth-unavailable",
      diagnostic: "repair gh auth",
    });
  });
});
