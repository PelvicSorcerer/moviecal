// Pure machine-wide iOS simulator lease policy (MOV-309); CLI I/O is injected for deterministic tests.

export const LANES = Object.freeze(["ci", "worker", "manual"]);
export const LANE_DEVICES = Object.freeze({ ci: "moviecal-ci", worker: "moviecal-worker", manual: "moviecal-manual" });

/** The pre-existing shared device. Never created, modified, or deleted by this tool. */
export const SHARED_DEVICE_NAME = "iPhone 17";
const DEVICE_TYPE_IDENTIFIER = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

export const MINUTE_MS = 60_000;
export const MANUAL_LEASE_MS = 20 * MINUTE_MS;
export const MANUAL_HARD_CAP_MS = 60 * MINUTE_MS;
export const MANUAL_WARNING_LEAD_MS = 5 * MINUTE_MS;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = 3 * MINUTE_MS;

/** Per-lane waiting budget before a waiter gives up with the labeled exit code. */
export const DEFAULT_WAIT_MS = Object.freeze({ ci: 30 * MINUTE_MS, worker: 30 * MINUTE_MS, manual: 10 * MINUTE_MS });

/**
 * A waiting timeout is infrastructure unavailability, not a test failure, so it
 * gets its own exit code and a message no test runner produces.
 */
export const UNAVAILABLE_EXIT_CODE = 75;
export const UNAVAILABLE_MESSAGE = "SIMULATOR_LEASE_UNAVAILABLE";

export class LeaseUnavailableError extends Error {
  constructor(detail) {
    super(`${UNAVAILABLE_MESSAGE}: ${detail}`);
    this.name = "LeaseUnavailableError";
    this.exitCode = UNAVAILABLE_EXIT_CODE;
  }
}

/**
 * MOV-493: how long `ios:sim:run --progress-within` waits, measured from the
 * moment the simulator is booted, for the wrapped command to print its first
 * test-suite start. Two failed lane-ios runs sat silent for ~20 minutes between
 * a 1m12s build and the first suite before the 35-minute step budget killed
 * them; passing runs start suites within a couple of minutes of boot. 8 minutes
 * is several times the healthy gap yet leaves ~27 minutes of the step budget
 * for diagnostics and release instead of burning all of it with no signal.
 */
export const EARLY_PROGRESS_LIMIT_MS = 8 * MINUTE_MS;
export const EARLY_PROGRESS_EXIT_CODE = 76;
export const EARLY_PROGRESS_MESSAGE = "SIMULATOR_TESTS_NOT_STARTED";
/** XCTest's first line of real progress: `Test Suite 'All tests' started at …`. */
export const DEFAULT_PROGRESS_PATTERN = /Test Suite '[^']*' started at/u;

/**
 * Releasing shuts the simulator down; after both observed timeouts that took
 * 1 to 3.5 minutes. The lease record is already cleared by then, so a wedged
 * shutdown is abandoned after this bound (the next job's start-of-job cleanup
 * shuts any leftover lane device down) instead of stalling the whole job.
 */
export const RELEASE_SHUTDOWN_TIMEOUT_MS = 60_000;

/**
 * MOV-497: `simctl shutdown` can exit 0 while CoreSimulatorService is wedged and
 * the device stays Booted. After every shutdown the state is re-read and polled
 * for up to this long; if it is still Booted the shutdown is retried once and
 * polled again before giving up with SIMULATOR_STILL_BOOTED_AFTER_SHUTDOWN.
 * A healthy shutdown reports Shutdown on the first read, so this costs nothing.
 */
export const SHUTDOWN_VERIFY_TIMEOUT_MS = 15_000;
export const SHUTDOWN_VERIFY_POLL_MS = 1_000;
export const STILL_BOOTED_MESSAGE = "SIMULATOR_STILL_BOOTED_AFTER_SHUTDOWN";

/** A job whose device cannot be shut down fails fast with its own label and exit code. */
export const SERVICE_UNRESPONSIVE_EXIT_CODE = 77;
export const SERVICE_UNRESPONSIVE_MESSAGE = "SIMULATOR_SERVICE_UNRESPONSIVE";

export class ServiceUnresponsiveError extends Error {
  constructor(detail) {
    super(`${SERVICE_UNRESPONSIVE_MESSAGE}: ${detail}`);
    this.name = "ServiceUnresponsiveError";
    this.exitCode = SERVICE_UNRESPONSIVE_EXIT_CODE;
  }
}

/**
 * `simctl bootstatus -b` boots the device if needed and waits for it. Ten
 * minutes is the pre-existing bound, kept because a cold boot of a fresh device
 * on the shared Mac is the slowest legitimate case; it still leaves most of the
 * 35-minute test-step budget. A wedged service is caught earlier by the
 * post-shutdown check, so this only bounds a device that is merely slow.
 */
export const BOOTSTATUS_TIMEOUT_MS = 10 * MINUTE_MS;

/**
 * Diagnostics run their commands in parallel; each has its own hard timeout and
 * the whole capture is abandoned at this total, so one hung command cannot
 * delay the others or the release that follows.
 */
export const DIAGNOSTICS_TOTAL_CAP_MS = 60_000;

/**
 * Polls `read()` (returns a simulator state string, or null when unreadable)
 * until it reports Shutdown or `timeoutMs` passes. Always reads at least once.
 */
export function pollUntilShutdown({ read, now, sleep, timeoutMs = SHUTDOWN_VERIFY_TIMEOUT_MS, pollMs = SHUTDOWN_VERIFY_POLL_MS }) {
  const startedAt = now();
  let reads = 0;
  for (;;) {
    reads += 1;
    const state = read();
    const elapsedMs = now() - startedAt;
    if (state === "Shutdown") return { shutdown: true, state, reads, elapsedMs };
    if (elapsedMs >= timeoutMs) return { shutdown: false, state, reads, elapsedMs };
    sleep(Math.min(pollMs, timeoutMs - elapsedMs));
  }
}

/** Summed per-core times as percentages; with `previous` it is the change between the two samples. */
export function cpuSplit(current, previous = null) {
  const total = (cpus) =>
    cpus.reduce(
      (sum, { times }) => ({
        user: sum.user + times.user + times.nice,
        system: sum.system + times.sys + times.irq,
        idle: sum.idle + times.idle,
      }),
      { user: 0, system: 0, idle: 0 },
    );
  const now = total(current);
  const before = previous ? total(previous) : { user: 0, system: 0, idle: 0 };
  const delta = { user: now.user - before.user, system: now.system - before.system, idle: now.idle - before.idle };
  const sum = delta.user + delta.system + delta.idle;
  if (sum <= 0) return null;
  const pct = (value) => Math.round((value / sum) * 100);
  return { user: pct(delta.user), system: pct(delta.system), idle: pct(delta.idle) };
}

/** Explains a non-live lease so a short-lived `acquire` process does not look like a bug. */
export function describeNotLive(lease, reason) {
  if (reason === "holder-gone" || reason === "heartbeat-stale") {
    return (
      `not live — ${reason}: the process that acquired it (pid ${lease?.holder?.pid ?? "unknown"}) has exited; a ` +
      `${lease?.lane ?? "ci/worker"} lease is kept alive only while \`ios:sim:run\` or \`ios:sim:watch\` is running`
    );
  }
  return `not live — ${reason}`;
}

/**
 * Early-progress timer with an injected clock. Output is matched across chunk
 * boundaries; once progress is seen the watch never fails.
 */
export function createProgressWatch({ limitMs = EARLY_PROGRESS_LIMIT_MS, pattern = DEFAULT_PROGRESS_PATTERN, startedAtMs }) {
  let seen = false;
  let tail = "";
  return {
    get seen() {
      return seen;
    },
    onOutput(chunk) {
      if (seen) return true;
      const text = tail + String(chunk);
      seen = pattern.test(text);
      tail = text.slice(-512);
      return seen;
    },
    expired(nowMs) {
      return !seen && nowMs - startedAtMs >= limitMs;
    },
  };
}

/**
 * MOV-500: how long the wrapped command may print nothing (stdout and stderr)
 * at any point in the run before it is treated as stalled. Healthy xcodebuild
 * runs print continuously; the lane-ios run of 2026-11-02 (41499145743) went
 * silent for ~28.5 minutes between the unit bundle finishing (18:21:39Z) and the
 * UI test runner starting (18:50:07Z) and used 32.5 of its 35 minutes. 10 minutes
 * is far above any gap between lines in a healthy run, including a slow UI
 * runner startup, yet fails a wedge ~25 minutes before the step timeout. No
 * healthy bundle-to-bundle gap has been measured from telemetry yet; see
 * docs/operators/local-execution.md.
 */
export const OUTPUT_IDLE_LIMIT_MS = 10 * MINUTE_MS;
export const OUTPUT_IDLE_EXIT_CODE = 78;
export const OUTPUT_IDLE_MESSAGE = "SIMULATOR_TEST_OUTPUT_STALLED";
/** Suite and test-case lines, kept so a stall report can say where the run stopped. */
export const DEFAULT_LAST_LINE_PATTERN = /^\s*Test (?:Suite|Case) /u;

/**
 * Output-idle timer with an injected clock. Time is measured from `startedAtMs`
 * until the first output, then from the latest output. Lines are reassembled
 * across chunk boundaries per source so the last suite/test line is exact.
 */
export function createIdleWatch({ limitMs = OUTPUT_IDLE_LIMIT_MS, startedAtMs, linePattern = DEFAULT_LAST_LINE_PATTERN }) {
  let lastOutputAtMs = null;
  let lastLine = null;
  const partial = new Map();
  return {
    get lastOutputAtMs() {
      return lastOutputAtMs;
    },
    get lastLine() {
      return lastLine;
    },
    onOutput(chunk, nowMs, source = "stdout") {
      lastOutputAtMs = nowMs;
      const lines = (partial.get(source) ?? "") + String(chunk);
      const parts = lines.split("\n");
      partial.set(source, parts.pop().slice(-1024));
      for (const line of parts) if (linePattern.test(line)) lastLine = line.trim();
    },
    expired(nowMs) {
      return nowMs - (lastOutputAtMs ?? startedAtMs) >= limitMs;
    },
  };
}

/**
 * MOV-493: a booted simulator is only safe to shut down at job start if this
 * repo's own scripts created it (a `moviecal-*` lane device) and the lease does
 * not own it. Anything else (`iPhone 17`, a human's own device) is left alone.
 */
export function selectStaleLaneDevices(bootedDevices = [], ownedUdids = []) {
  const owned = new Set(ownedUdids.filter(Boolean));
  const names = new Set(Object.values(LANE_DEVICES));
  return bootedDevices.filter((device) => names.has(device.name) && !owned.has(device.udid));
}

export class HardCapError extends Error {
  constructor(message) {
    super(message);
    this.name = "HardCapError";
    this.exitCode = 1;
  }
}

/**
 * The lane is a policy label derived from the environment, never a flag: a CI
 * job, a dispatcher worker, and a human-led session must not be able to claim
 * each other's device or expiry rules by passing an argument.
 */
export function detectLane(env = {}) {
  if (String(env.GITHUB_ACTIONS ?? "").toLowerCase() === "true") return "ci";
  if (String(env.MOVIECAL_WORKER_SANDBOX ?? "") === "1") return "worker";
  return "manual";
}

export function laneDevice(lane) {
  const device = LANE_DEVICES[lane];
  if (!device) throw new Error(`Unknown simulator lane: ${lane}`);
  return device;
}

export function emptyRecord() {
  return { version: 1, lease: null, waiters: [] };
}

export function normalizeRecord(raw) {
  const record = emptyRecord();
  if (raw && typeof raw === "object") {
    if (raw.lease && typeof raw.lease === "object") record.lease = raw.lease;
    if (Array.isArray(raw.waiters)) record.waiters = raw.waiters.filter((waiter) => waiter?.id);
  }
  return record;
}

export function sameHolder(left, right) {
  if (!left || !right || left.pid !== right.pid) return false;
  if (!left.startedAt || !right.startedAt) return true;
  return left.startedAt === right.startedAt;
}

export function createLease({ lane, id, holder, purpose, ref, device, nowMs }) {
  const acquiredAt = new Date(nowMs).toISOString();
  const manual = lane === "manual";
  return {
    id, lane, holder, purpose: purpose ?? null, ref: ref ?? null, device, acquiredAt,
    expiresAt: new Date(nowMs + (manual ? MANUAL_LEASE_MS : HEARTBEAT_STALE_MS)).toISOString(),
    hardCapAt: manual ? new Date(nowMs + MANUAL_HARD_CAP_MS).toISOString() : null,
    heartbeatAt: manual ? null : acquiredAt,
  };
}

/**
 * `ci`/`worker` holders are bounded processes, so pid + start-time liveness plus
 * a heartbeat is meaningful. A `manual` lease is deliberately time-based only:
 * closing the terminal that ran `acquire` must not free a simulator a human is
 * still testing on.
 */
export function leaseLiveness(lease, { nowMs, isProcessAlive = () => true } = {}) {
  if (!lease) return { live: false, reason: "no-lease" };
  if (lease.lane === "manual") {
    const expiresAt = Date.parse(lease.expiresAt);
    if (Number.isNaN(expiresAt)) return { live: false, reason: "malformed" };
    return nowMs < expiresAt ? { live: true, reason: "held" } : { live: false, reason: "expired" };
  }
  if (!isProcessAlive(lease.holder)) return { live: false, reason: "holder-gone" };
  const beat = Date.parse(lease.heartbeatAt ?? lease.acquiredAt);
  if (Number.isNaN(beat)) return { live: false, reason: "malformed" };
  if (nowMs - beat > HEARTBEAT_STALE_MS) return { live: false, reason: "heartbeat-stale" };
  return { live: true, reason: "held" };
}

/**
 * Renewal for `manual` is clamped to the hard cap measured from the *first*
 * acquisition; past it the holder must release, and the re-acquire is a new
 * lease that queues behind any waiters.
 */
export function renewLease(lease, nowMs) {
  if (lease.lane !== "manual") {
    return { ...lease, heartbeatAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + HEARTBEAT_STALE_MS).toISOString() };
  }
  const cap = Date.parse(lease.hardCapAt);
  if (Number.isNaN(cap)) throw new HardCapError("The manual lease record has no usable hard cap.");
  if (nowMs >= cap) {
    throw new HardCapError(
      "This manual lease reached its 60-minute hard cap. Run `npm run ios:sim:release`; " +
        "a re-acquire is a new lease that queues behind any waiters.",
    );
  }
  return { ...lease, expiresAt: new Date(Math.min(nowMs + MANUAL_LEASE_MS, cap)).toISOString() };
}

export function pruneWaiters(record, isProcessAlive = () => true) {
  const kept = record.waiters.filter((waiter) => isProcessAlive(waiter));
  const removed = record.waiters.length - kept.length;
  record.waiters = kept;
  return removed;
}

/** FIFO: an existing waiter keeps its place, a new one goes to the back. */
export function enqueueWaiter(record, waiter) {
  const at = record.waiters.findIndex((candidate) => candidate.id === waiter.id);
  if (at < 0) return record.waiters.push(waiter) - 1;
  record.waiters[at] = { ...record.waiters[at], ...waiter, since: record.waiters[at].since };
  return at;
}

export function removeWaiter(record, id) {
  const before = record.waiters.length;
  record.waiters = record.waiters.filter((waiter) => waiter.id !== id);
  return before !== record.waiters.length;
}

export function waiterPosition(record, id) {
  return record.waiters.findIndex((waiter) => waiter.id === id);
}

export function isHeadWaiter(record, id) {
  return record.waiters[0]?.id === id;
}

/**
 * Reality check, not just the file: a booted simulator or a running `xcodebuild`
 * that no live lease accounts for is unmanaged manual use. It is waited on and
 * reported, never shut down automatically.
 */
export function unmanagedState({ bootedDevices = [], xcodebuildProcesses = [], ownedUdids = [], hasLiveLease = false } = {}) {
  const owned = new Set(ownedUdids.filter(Boolean));
  const devices = bootedDevices.filter((device) => !owned.has(device.udid));
  const xcodebuild = hasLiveLease ? [] : xcodebuildProcesses;
  return { unmanaged: devices.length > 0 || xcodebuild.length > 0, devices, xcodebuild };
}

export function describeUnmanaged(state) {
  const parts = [];
  if (state.devices.length > 0) {
    parts.push(`booted simulator(s) ${state.devices.map((device) => `${device.name} (${device.udid})`).join(", ")}`);
  }
  if (state.xcodebuild.length > 0) parts.push(`running xcodebuild pid(s) ${state.xcodebuild.join(", ")}`);
  return `unmanaged simulator use: ${parts.join(" and ")}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes === 0 ? `${total}s` : `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}

/** Idempotent device plan: an existing lane device is reported and left exactly as it is. */
export function resolveSetupPlan({ devices = [], runtimes = [] } = {}) {
  const shared = devices.find((device) => device.name === SHARED_DEVICE_NAME && device.isAvailable !== false);
  const newest = runtimes
    .filter((runtime) => runtime.isAvailable !== false && /iOS/u.test(runtime.identifier ?? ""))
    .sort((a, b) => String(a.version ?? "").localeCompare(String(b.version ?? ""), undefined, { numeric: true }))
    .at(-1);
  const runtime = shared?.runtime ?? newest?.identifier ?? null;
  if (!runtime) throw new Error("No available iOS simulator runtime was found. Install one in Xcode, then re-run setup.");

  const plan = LANES.map((lane) => {
    const name = laneDevice(lane);
    const existing = devices.find((device) => device.name === name);
    return existing
      ? { lane, name, action: "existing", udid: existing.udid, runtime: existing.runtime }
      : { lane, name, action: "create", runtime, deviceType: DEVICE_TYPE_IDENTIFIER };
  });
  return { runtime, plan };
}

/**
 * Printed after a successful manual-lane acquire, addressed to the agent that
 * ran it on a human's behalf. An interactive Claude/Codex session is in the
 * `manual` lane by design, and a lease it forgets to release blocks CI, the
 * dispatcher, and the next human.
 */
export function agentGuidance(lease) {
  const rule = "-".repeat(72);
  return [
    rule,
    `iOS simulator lease acquired (manual lane) — lease id ${lease.id}`,
    `  device:   ${lease.device.name} (${lease.device.udid})`,
    `  expires:  ${lease.expiresAt} (20 minutes from now)`,
    `  hard cap: ${lease.hardCapAt} (60 minutes from first acquisition)`,
    "",
    "Agent instructions:",
    "  If you set this simulator up for the user's manual testing, run `npm run ios:sim:release` as soon as the user says they are finished testing.",
    "  Renew with `npm run ios:sim:extend` before the 20-minute expiry; renewal never passes the 60-minute hard cap.",
    "  After the hard cap you must release; a re-acquire queues behind any waiters.",
    "  `npm run ios:sim:status` shows who is waiting and for how long.",
    rule,
  ].join("\n");
}
