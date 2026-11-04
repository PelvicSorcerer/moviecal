// MOV-503: stall classification, episode keying, config parsing, and a
// deterministic fake-clock run of the watchdog pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_AGENT_WORKING_MS,
  DEFAULT_STALL_IN_REVIEW_MS,
  DEFAULT_STALL_WATCHDOG_INTERVAL_MS,
  resolveStallThresholds,
  resolveStallWatchdogIntervalMs,
} from "../src/config.mjs";
import { OwnerNotificationLedger, escalateToOwner } from "../src/owner-escalation.mjs";
import {
  StallLedger,
  classifyStall,
  isPrGreen,
  lastDispatcherEvent,
  runStallWatchdog,
  stallFingerprint,
} from "../src/stall-watchdog.mjs";

const HOUR = 60 * 60 * 1000;
const SILENT = { warn() {}, error() {}, log() {} };
const THRESHOLDS = { agentWorkingMs: 2 * HOUR, inReviewMs: 12 * HOUR };
const BOT = "bot-1";

function pr(outcome = "success", headSha = "sha-1") {
  return {
    prNumber: 7, prUrl: "https://github.test/pr/7", headSha,
    checks: { required: [{ name: "verify", outcome }], missingRequired: [], pending: outcome === "pending", timedOut: false },
  };
}

describe("config", () => {
  it("defaults to 10 minutes, 2 hours and 12 hours", () => {
    expect(resolveStallWatchdogIntervalMs({})).toBe(DEFAULT_STALL_WATCHDOG_INTERVAL_MS);
    expect(resolveStallThresholds({})).toEqual({ agentWorkingMs: DEFAULT_STALL_AGENT_WORKING_MS, inReviewMs: DEFAULT_STALL_IN_REVIEW_MS });
    expect(DEFAULT_STALL_AGENT_WORKING_MS).toBe(2 * HOUR);
    expect(DEFAULT_STALL_IN_REVIEW_MS).toBe(12 * HOUR);
  });

  it("honours env overrides and ignores invalid ones", () => {
    expect(resolveStallThresholds({ MOVIECAL_STALL_AGENT_WORKING_MS: "1000", MOVIECAL_STALL_IN_REVIEW_MS: "2000" })).toEqual({ agentWorkingMs: 1000, inReviewMs: 2000 });
    expect(resolveStallThresholds({ MOVIECAL_STALL_AGENT_WORKING_MS: "0", MOVIECAL_STALL_IN_REVIEW_MS: "abc" })).toEqual({ agentWorkingMs: DEFAULT_STALL_AGENT_WORKING_MS, inReviewMs: DEFAULT_STALL_IN_REVIEW_MS });
    expect(resolveStallWatchdogIntervalMs({ MOVIECAL_STALL_WATCHDOG_INTERVAL_MS: "5000" })).toBe(5000);
    expect(resolveStallWatchdogIntervalMs({ MOVIECAL_STALL_WATCHDOG_INTERVAL_MS: "-1" })).toBe(DEFAULT_STALL_WATCHDOG_INTERVAL_MS);
  });
});

describe("classifyStall", () => {
  const base = { nowMs: 100 * HOUR, thresholds: THRESHOLDS };
  it("flags Agent Working only without a live worker and past the threshold", () => {
    expect(classifyStall({ ...base, stateName: "Agent Working", live: false, sinceMs: 97 * HOUR })).toMatchObject({ kind: "no-worker" });
    expect(classifyStall({ ...base, stateName: "Agent Working", live: false, sinceMs: 99 * HOUR })).toBeNull();
    expect(classifyStall({ ...base, stateName: "Agent Working", live: true, sinceMs: 0 })).toBeNull();
  });

  it("classifies In Review as green or stale-ci past 12h", () => {
    expect(classifyStall({ ...base, stateName: "In Review", pr: pr("success"), sinceMs: 80 * HOUR })).toMatchObject({ kind: "green" });
    expect(classifyStall({ ...base, stateName: "In Review", pr: pr("failure"), sinceMs: 80 * HOUR })).toMatchObject({ kind: "stale-ci" });
    expect(classifyStall({ ...base, stateName: "In Review", pr: pr("pending"), sinceMs: 80 * HOUR })).toMatchObject({ kind: "stale-ci" });
    expect(classifyStall({ ...base, stateName: "In Review", pr: pr("success"), sinceMs: 95 * HOUR })).toBeNull();
    expect(classifyStall({ ...base, stateName: "Backlog", live: false, sinceMs: 0 })).toBeNull();
  });

  it("treats missing required checks as not green", () => {
    const p = pr("success");
    p.checks.missingRequired = ["lane-ios"];
    expect(isPrGreen(p)).toBe(false);
  });
});

describe("fingerprint", () => {
  it("changes with head, check outcomes, worker presence and dispatcher events", () => {
    const a = stallFingerprint({ stateName: "In Review", live: false, event: null, pr: pr("success") });
    expect(stallFingerprint({ stateName: "In Review", live: false, event: null, pr: pr("success") })).toBe(a);
    expect(stallFingerprint({ stateName: "In Review", live: false, event: null, pr: pr("failure") })).not.toBe(a);
    expect(stallFingerprint({ stateName: "In Review", live: false, event: null, pr: pr("success", "sha-2") })).not.toBe(a);
    expect(stallFingerprint({ stateName: "In Review", live: true, event: null, pr: pr("success") })).not.toBe(a);
    expect(stallFingerprint({ stateName: "In Review", live: false, event: { id: "c1" }, pr: pr("success") })).not.toBe(a);
  });

  it("ignores watchdog asks, CI status comments and human comments as dispatcher events", () => {
    const comments = [
      { id: "c1", body: "Started work", isBot: true },
      { id: "c2", body: "human note", authorId: "human" },
      { id: "c3", body: "Needs you: no worker", isBot: true },
      { id: "c4", body: "**CI observation (read-only)** — PR #1", isBot: true },
    ];
    expect(lastDispatcherEvent(comments, [BOT]).id).toBe("c1");
  });
});

describe("runStallWatchdog with a fake clock", () => {
  let dir;
  let clock;
  let log;
  let live;
  let prState;
  let issue;
  let stallLedger;
  let ownerLedger;
  let linearClient;

  const now = () => new Date(clock);
  const run = () => runStallWatchdog({
    issues: [issue], linearClient, stallLedger, ownerLedger, thresholds: THRESHOLDS, botUserIds: [BOT], now, logger: SILENT,
    isLive: () => live,
    observePr: () => prState,
    escalateToOwner,
    needsHumanDecisionStateId: "state-nhd",
  });
  const comments = () => log.filter((e) => e.type === "comment");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-watchdog-"));
    stallLedger = new StallLedger(path.join(dir, "stall.json"));
    ownerLedger = new OwnerNotificationLedger(path.join(dir, "owner.json"));
    clock = Date.parse("2026-11-03T00:00:00Z");
    log = [];
    live = false;
    prState = pr("success");
    issue = {
      id: "id-1", identifier: "MOV-1", url: "https://linear.app/moviecal/issue/MOV-1/x",
      assignee: { id: "user-adam", displayName: "adam" }, delegate: { id: BOT }, stateName: "Agent Working",
      comments: [{ id: "c1", body: "Dispatcher started the worker", isBot: true, createdAt: new Date(clock).toISOString() }],
    };
    linearClient = {
      async addComment(issueId, body) { log.push({ type: "comment", issueId, body }); return true; },
      async moveToState(issueId, stateId) { log.push({ type: "move", issueId, stateId }); return true; },
    };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("never flags an issue with a live worker, however long it runs", async () => {
    live = true;
    for (let i = 0; i < 10; i++) { await run(); clock += 3 * HOUR; }
    expect(log).toEqual([]);
  });

  it("escalates a workerless Agent Working issue once, then again after a change and a new stall", async () => {
    await run();
    clock += HOUR;
    await run();
    expect(log).toEqual([]);

    clock += 2 * HOUR;
    await run();
    await run();
    clock += HOUR;
    await run();
    expect(comments()).toHaveLength(1);
    expect(comments()[0].body.startsWith("Needs you: no worker has run for 3h")).toBe(true);
    expect(comments()[0].body).toContain("Last dispatcher event");
    expect(comments()[0].body).toContain("Dispatcher started the worker");
    expect(comments()[0].body).toContain("profiles/adam");
    expect(log.filter((e) => e.type === "move")).toEqual([{ type: "move", issueId: "id-1", stateId: "state-nhd" }]);

    // The owner requeues it; a new worker runs and posts, then the issue stalls again.
    issue = { ...issue, comments: [...issue.comments, { id: "c2", body: "Worker finished", isBot: true, createdAt: new Date(clock).toISOString() }] };
    await run();
    clock += 3 * HOUR;
    await run();
    await run();
    expect(comments()).toHaveLength(2);
  });

  it("survives a restart without re-escalating or resetting the clock", async () => {
    await run();
    clock += 3 * HOUR;
    await run();
    stallLedger = new StallLedger(path.join(dir, "stall.json"));
    ownerLedger = new OwnerNotificationLedger(path.join(dir, "owner.json"));
    await run();
    expect(comments()).toHaveLength(1);
  });

  it("posts a mention-only ask for a green In Review PR and leaves the state alone", async () => {
    issue = { ...issue, stateName: "In Review" };
    await run();
    clock += 13 * HOUR;
    await run();
    await run();
    expect(comments()).toHaveLength(1);
    expect(comments()[0].body.startsWith("Needs you: PR #7 (https://github.test/pr/7) is green and waiting for review or merge")).toBe(true);
    expect(comments()[0].body).toContain("profiles/adam");
    expect(log.filter((e) => e.type === "move")).toEqual([]);
  });

  it("escalates a stale red In Review PR naming the failing checks, and a new head resets the episode", async () => {
    issue = { ...issue, stateName: "In Review" };
    prState = pr("failure");
    await run();
    clock += 13 * HOUR;
    await run();
    expect(comments()).toHaveLength(1);
    expect(comments()[0].body.startsWith("Needs you: PR #7 (https://github.test/pr/7) has had no CI or commit change for 13h")).toBe(true);
    expect(comments()[0].body).toContain("verify (failure)");
    expect(log.filter((e) => e.type === "move")).toHaveLength(1);

    issue = { ...issue, stateName: "In Review" };
    prState = pr("failure", "sha-2");
    await run();
    clock += 11 * HOUR;
    await run();
    expect(comments()).toHaveLength(1);
    clock += 2 * HOUR;
    await run();
    expect(comments()).toHaveLength(2);
  });

  it("skips an issue whose PR cannot be observed and issues not delegated to the dispatcher", async () => {
    issue = { ...issue, stateName: "In Review" };
    prState = { observationError: true };
    await run();
    clock += 20 * HOUR;
    expect((await run())[0].action).toBe("skipped");
    prState = pr("success");
    issue = { ...issue, delegate: { id: "someone-else" } };
    expect(await run()).toEqual([]);
    expect(log).toEqual([]);
  });
});
