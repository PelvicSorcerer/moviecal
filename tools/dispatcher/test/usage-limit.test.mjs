import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_USAGE_LIMIT_DEFERRAL_MS,
  PROVIDER_USAGE_LIMIT,
  UsageLimitStore,
  classifyUsageLimitFailure,
  decideUsageLimitOutcome,
  parseUsageLimitReset,
} from "../src/usage-limit.mjs";

// A fixed "now" in UTC so the wall-clock cases below are deterministic. The
// process timezone is whatever the machine/CI has, which is exactly why the
// wall-clock assertions check *relative* offsets rather than absolute hours.
const NOW = new Date("2026-09-14T12:00:00.000Z");

describe("parseUsageLimitReset", () => {
  it("reads an epoch-seconds reset stamp", () => {
    const parsed = parseUsageLimitReset("session limit reached, resets at 1789000000", { now: NOW });
    expect(parsed.precision).toBe("epoch");
    expect(parsed.resetAt.toISOString()).toBe(new Date(1789000000 * 1000).toISOString());
  });

  it("reads an ISO reset stamp", () => {
    const parsed = parseUsageLimitReset("usage limit reached · resets 2026-09-14T17:30:00Z", { now: NOW });
    expect(parsed.precision).toBe("iso");
    expect(parsed.resetAt.toISOString()).toBe("2026-09-14T17:30:00.000Z");
  });

  it("reads a relative interval", () => {
    const parsed = parseUsageLimitReset("5-hour session limit reached; resets in 2 hours 30 minutes", { now: NOW });
    expect(parsed.precision).toBe("relative");
    expect(parsed.resetAt.getTime() - NOW.getTime()).toBe(2.5 * 60 * 60 * 1000);
  });

  it("reads a bare wall-clock time and always resolves it into the future", () => {
    for (const message of ["resets 3pm", "resets at 3:00pm", "resets 3pm (America/New_York)"]) {
      const parsed = parseUsageLimitReset(`Claude usage limit reached. ${message}`, { now: NOW });
      const deltaMs = parsed.resetAt.getTime() - NOW.getTime();
      expect(deltaMs).toBeGreaterThan(0);
      expect(deltaMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    }
  });

  it("falls back to the local zone when the named timezone is not a real one", () => {
    const zoned = parseUsageLimitReset("usage limit reached, resets 3pm (Not/AZone)", { now: NOW });
    const local = parseUsageLimitReset("usage limit reached, resets 3pm", { now: NOW });
    expect(zoned.resetAt.getTime()).toBe(local.resetAt.getTime());
  });

  it("returns null when there is no reset time to extract", () => {
    expect(parseUsageLimitReset("session limit reached, resets soon", { now: NOW })).toBeNull();
    expect(parseUsageLimitReset("", { now: NOW })).toBeNull();
    // 25 is not an hour, and without am/pm there is nothing else it could be.
    expect(parseUsageLimitReset("usage limit reached, resets 25", { now: NOW })).toBeNull();
  });
});

describe("classifyUsageLimitFailure", () => {
  it("recognizes a non-zero exit carrying a session-limit message", () => {
    const result = classifyUsageLimitFailure({
      exitCode: 1,
      logTail: "Claude AI usage limit reached · resets 2026-09-14T17:00:00Z",
      now: NOW,
    });
    expect(result).toMatchObject({ category: PROVIDER_USAGE_LIMIT, resetAt: "2026-09-14T17:00:00.000Z" });
  });

  // Acceptance criterion: "Any other non-zero worker exit is not treated as
  // the usage-limit class and still escalates immediately as today."
  it.each([
    ["an ordinary test failure", "FAIL test/foo.test.ts — expected 1 to be 2"],
    ["a build failure", "error TS2345: Argument of type 'string' is not assignable"],
    ["the nested-sandbox crash", "sandbox-exec: sandbox_apply: Operation not permitted"],
    ["a limit word with no reset", "429 rate limit exceeded contacting the registry"],
    ["a reset word with no limit", "resets at 3pm"],
  ])("does not claim %s", (_label, logTail) => {
    expect(classifyUsageLimitFailure({ exitCode: 1, logTail, now: NOW })).toBeNull();
  });

  it("never claims a zero exit, whatever the log says", () => {
    expect(
      classifyUsageLimitFailure({ exitCode: 0, logTail: "session limit reached · resets 3pm", now: NOW }),
    ).toBeNull();
  });

  it("still recognizes the class when the reset time is unparseable, so the caller can escalate knowingly", () => {
    const result = classifyUsageLimitFailure({ exitCode: 1, logTail: "session limit reached, resetting shortly", now: NOW });
    expect(result).toMatchObject({ category: PROVIDER_USAGE_LIMIT, resetAt: null });
  });
});

describe("decideUsageLimitOutcome", () => {
  const classification = { category: PROVIDER_USAGE_LIMIT, resetAt: "2026-09-14T17:00:00.000Z", evidence: "session limit" };

  it("schedules exactly one retry at the parsed reset time", () => {
    const verdict = decideUsageLimitOutcome({ classification, previous: null, now: NOW });
    expect(verdict).toMatchObject({ action: "retry-at-reset", retryAt: "2026-09-14T17:00:00.000Z", consecutive: 1 });
  });

  it("escalates on the second consecutive usage-limit failure for the same issue", () => {
    const verdict = decideUsageLimitOutcome({
      classification,
      previous: { consecutive: 1, retryAt: "2026-09-14T11:00:00.000Z" },
      now: NOW,
    });
    expect(verdict.action).toBe("escalate");
    expect(verdict.consecutive).toBe(2);
    expect(verdict.reason).toMatch(/second consecutive/);
  });

  it("escalates when no reset time could be parsed", () => {
    const verdict = decideUsageLimitOutcome({
      classification: { ...classification, resetAt: null },
      now: NOW,
    });
    expect(verdict.action).toBe("escalate");
    expect(verdict.reason).toMatch(/no reset time could be parsed/);
  });

  it("escalates rather than parking an issue beyond the deferral ceiling", () => {
    const verdict = decideUsageLimitOutcome({
      classification: { ...classification, resetAt: new Date(NOW.getTime() + MAX_USAGE_LIMIT_DEFERRAL_MS + 60_000).toISOString() },
      now: NOW,
    });
    expect(verdict.action).toBe("escalate");
    expect(verdict.reason).toMatch(/more than 24h away/);
  });

  it("retries immediately when the window already lifted", () => {
    const verdict = decideUsageLimitOutcome({
      classification: { ...classification, resetAt: "2026-09-14T11:00:00.000Z" },
      now: NOW,
    });
    expect(verdict).toMatchObject({ action: "retry-at-reset", retryAt: NOW.toISOString() });
  });

  it("is not applicable to a failure that is not this class", () => {
    expect(decideUsageLimitOutcome({ classification: null, now: NOW }).action).toBe("not-applicable");
  });
});

describe("UsageLimitStore", () => {
  let tmpRoot;
  let statePath;
  let store;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-usage-limit-test-"));
    statePath = path.join(tmpRoot, "config", "usage-limits.json");
    store = new UsageLimitStore(statePath);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("defers dispatch until the recorded reset, then stops deferring", () => {
    store.record("MOV-1", { retryAt: "2026-09-14T17:00:00.000Z", evidence: "session limit", now: NOW });

    expect(store.deferral("MOV-1", NOW)).toMatchObject({ deferred: true, until: "2026-09-14T17:00:00.000Z" });
    expect(store.deferral("MOV-1", new Date("2026-09-14T17:00:01Z")).deferred).toBe(false);
    expect(store.deferral("MOV-2", NOW).deferred).toBe(false);
  });

  // The wait outlives the daemon's own uptime guarantees, so it has to be
  // readable by a process that restarted inside the window.
  it("survives a restart", () => {
    store.record("MOV-1", { retryAt: "2026-09-14T17:00:00.000Z", now: NOW });
    expect(new UsageLimitStore(statePath).deferral("MOV-1", NOW).deferred).toBe(true);
  });

  it("counts consecutive failures and forgets them on clear()", () => {
    expect(store.record("MOV-1", { retryAt: null, now: NOW }).consecutive).toBe(1);
    expect(store.record("MOV-1", { retryAt: null, now: NOW }).consecutive).toBe(2);
    store.clear("MOV-1");
    expect(store.get("MOV-1")).toBeNull();
    expect(store.record("MOV-1", { retryAt: null, now: NOW }).consecutive).toBe(1);
  });

  it("clear() on an unknown issue is a no-op", () => {
    expect(() => store.clear("MOV-404")).not.toThrow();
  });
});
