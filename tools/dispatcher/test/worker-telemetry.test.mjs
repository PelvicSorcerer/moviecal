import { describe, expect, it, vi } from "vitest";
import { attemptLabel, installTimestampedConsole, withWorkerMarkers } from "../src/worker-telemetry.mjs";

const args = (extra = {}) => ({ issueIdentifier: "MOV-9", invocation: { command: "claude" }, logDir: "/logs/MOV-9-slug", ...extra });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(spawnWorkerFn) {
  const emit = vi.fn();
  const logger = { log: vi.fn() };
  let t = 1000;
  const wrapped = withWorkerMarkers(spawnWorkerFn, { emit, logger, now: () => (t += 4000) });
  return { emit, logger, wrapped };
}

describe("worker spawn/exit markers", () => {
  it("emits spawned then exited for a clean exit and returns the original promise", async () => {
    const promise = Promise.resolve({ exitCode: 0, logDir: "/x" });
    const { emit, logger, wrapped } = setup(() => promise);
    expect(wrapped(args())).toBe(promise);
    await settle();
    expect(emit).toHaveBeenNthCalledWith(1, "worker-spawned", { issue: "MOV-9", adapter: "claude", attempt: "initial" });
    expect(emit).toHaveBeenNthCalledWith(2, "worker-exited", {
      issue: "MOV-9", adapter: "claude", attempt: "initial", exitCode: 0, classification: "ok", durationMs: 4000,
    });
    expect(logger.log).toHaveBeenCalledTimes(2);
  });

  it("classifies failures, aborts and rejections, and unwraps a steering handle", async () => {
    const failed = setup(() => Promise.resolve({ exitCode: 2 }));
    failed.wrapped(args());
    const aborted = setup(() => ({ promise: Promise.resolve({ exitCode: 143 }) }));
    const controller = new AbortController();
    controller.abort();
    aborted.wrapped(args({ signal: controller.signal, logDir: "/logs/MOV-9/budget-continuation" }));
    const rejected = setup(() => Promise.reject(new Error("boom")));
    const original = rejected.wrapped(args());
    original.catch(() => {});
    await settle();
    expect(failed.emit.mock.calls[1][1]).toMatchObject({ classification: "failed", exitCode: 2 });
    expect(aborted.emit.mock.calls[1][1]).toMatchObject({ classification: "aborted", attempt: "budget-continuation" });
    expect(rejected.emit.mock.calls[1][1]).toMatchObject({ classification: "spawn-error", exitCode: null });
    await expect(original).rejects.toThrow("boom");
  });

  it("labels operator-resume attempts", () => {
    expect(attemptLabel("/logs/MOV-9/operator-resume/abc")).toBe("operator-resume:abc");
  });
});

describe("timestamped console", () => {
  it("prefixes strings and leaves format arguments in place", () => {
    const target = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const log = target.log;
    installTimestampedConsole(target, () => new Date("2026-11-02T10:00:00.123Z"));
    target.log("hello %s", "x");
    target.error({ a: 1 });
    expect(log).toHaveBeenCalledWith("2026-11-02T10:00:00.123Z hello %s", "x");
    expect(target.error).not.toBe(log);
  });
});
