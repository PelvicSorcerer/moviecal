#!/usr/bin/env node

// Machine-wide iOS simulator lease (MOV-309). Policy is pure; this file owns I/O and CLI.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonStateStore } from "../tools/dispatcher/src/state-store.mjs";
import {
  DEFAULT_WAIT_MS, HEARTBEAT_INTERVAL_MS, LeaseUnavailableError, MANUAL_WARNING_LEAD_MS, MINUTE_MS, SHARED_DEVICE_NAME,
  DEFAULT_PROGRESS_PATTERN, EARLY_PROGRESS_EXIT_CODE, EARLY_PROGRESS_LIMIT_MS, EARLY_PROGRESS_MESSAGE,
  RELEASE_SHUTDOWN_TIMEOUT_MS, OUTPUT_IDLE_EXIT_CODE, OUTPUT_IDLE_LIMIT_MS, OUTPUT_IDLE_MESSAGE, createIdleWatch, createProgressWatch, selectStaleLaneDevices,
  BOOTSTATUS_TIMEOUT_MS, DIAGNOSTICS_TOTAL_CAP_MS, STILL_BOOTED_MESSAGE, ServiceUnresponsiveError, cpuSplit, describeNotLive,
  pollUntilShutdown,
  agentGuidance, createLease, describeUnmanaged, detectLane, enqueueWaiter, formatDuration, isHeadWaiter, laneDevice,
  leaseLiveness, normalizeRecord, pruneWaiters, removeWaiter, renewLease, resolveSetupPlan, sameHolder, unmanagedState,
  waiterPosition,
} from "./lib/ios-sim-lease-core.mjs";

export * from "./lib/ios-sim-lease-core.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const COMMANDS = ["setup", "acquire", "release", "extend", "status", "adopt", "run", "watch"];
const MUTEX_TIMEOUT_MS = 15_000;
const MUTEX_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;

export function leasePath(env = process.env) {
  return path.join(env.MOVIECAL_IOS_SIM_STATE_DIR || path.join(os.homedir(), ".config", "moviecal"), "ios-sim-lease.json");
}

/** Same fsync + rename + `.bak` durability contract as the dispatcher's own state. */
export class LeaseStore extends JsonStateStore {
  get label() {
    return "iOS simulator lease state";
  }

  get file() {
    return this.statePath;
  }

  load() {
    return normalizeRecord(super.load());
  }
}

function runCommand(command, args, { timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, stdio: "pipe" });
  return { status: result.error ? 1 : (result.status ?? 1), stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Non-blocking `runCommand`; a command past its timeout is SIGKILLed and reported without waiting for it to exit. */
function runCommandAsync(command, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: 1, stdout: "", stderr: error.message });
      return;
    }
    const timer = setTimeout(() => {
      stderr += `\n(timed out after ${timeout}ms)`;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(1);
    }, timeout);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      stderr += error.message;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

function readStartTime(pid, run) {
  const result = run("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 10_000 });
  return (result.status === 0 ? result.stdout.trim() : "") || null;
}

function processAlive(holder, startTimeOf) {
  if (!holder?.pid) return false;
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  if (!holder.startedAt) return true;
  const current = startTimeOf(holder.pid);
  return !current || current === holder.startedAt;
}

/** Every side effect the commands need, in one injectable bag. */
export function createEnvironment(overrides = {}) {
  const env = overrides.env ?? process.env;
  const environment = {
    env,
    pid: process.pid,
    now: () => Date.now(),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: runCommand,
    runAsync: runCommandAsync,
    loadavg: () => os.loadavg(),
    cpus: () => os.cpus(),
    log: (message) => console.log(message),
    warn: (message) => console.error(message),
    store: new LeaseStore(leasePath(env)),
    mutexFile: `${leasePath(env)}.lock`,
    spawnWatcher,
    ...overrides,
  };

  let own;
  environment.processStartTime =
    overrides.processStartTime ??
    // Only this process's own start time is memoized — the mutex asks for it on
    // every poll. Another pid's is read fresh, because a cached value would make
    // a recycled pid look like the original holder.
    ((pid) => (pid === environment.pid ? (own ??= readStartTime(pid, environment.run)) : readStartTime(pid, environment.run)));
  environment.isProcessAlive = overrides.isProcessAlive ?? ((holder) => processAlive(holder, environment.processStartTime));
  // Notifications are best-effort; one must never fail a lease operation.
  environment.notify =
    overrides.notify ??
    ((title, body) =>
      environment.run("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], { timeout: 10_000 }));
  return environment;
}

function reclaimStaleMutex(environment) {
  let holder = null;
  let stats = null;
  try {
    stats = fs.statSync(environment.mutexFile);
    holder = JSON.parse(fs.readFileSync(environment.mutexFile, "utf8"));
  } catch {
    if (!stats) return false; // the lock vanished on its own; just retry the link
  }
  const abandoned =
    !holder?.pid ||
    !environment.isProcessAlive({ pid: holder.pid, startedAt: holder.startedAt }) ||
    Date.now() - stats.mtimeMs > MUTEX_STALE_MS;
  if (!abandoned) return false;
  try {
    fs.rmSync(environment.mutexFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Serializes every read-modify-write of the lease record across all processes. */
export function withMutex(environment, mutate) {
  const file = environment.mutexFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${environment.pid}.${randomUUID()}.tmp`;
  const holder = { pid: environment.pid, startedAt: environment.processStartTime(environment.pid), at: new Date().toISOString() };
  fs.writeFileSync(temporary, JSON.stringify(holder), { encoding: "utf8", mode: 0o600 });

  // Real wall-clock, deliberately: an injected test clock must not be able to
  // turn a bounded mutex wait into a hang (or vice versa).
  const deadline = Date.now() + MUTEX_TIMEOUT_MS;
  try {
    for (;;) {
      try {
        fs.linkSync(temporary, file); // atomic, so the lock never holds partial content
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (reclaimStaleMutex(environment)) continue;
        if (Date.now() >= deadline) throw new Error("Another ios-sim-lease process is holding the lease mutex; re-run in a moment.");
        environment.sleep(25);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }

  try {
    return mutate();
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8"))?.pid === environment.pid) fs.rmSync(file, { force: true });
    } catch {
      // someone else already reclaimed it as stale; nothing of ours to remove
    }
  }
}

// ------------------------------------------------------------------- simctl

function xcrun(environment) {
  return environment.env.MOVIECAL_IOS_SIM_XCRUN || "xcrun";
}

function simctl(environment, args, options = {}) {
  const result = environment.run(xcrun(environment), ["simctl", ...args], options);
  if (result.status !== 0) throw new Error(`xcrun simctl ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout;
}

export function listDevices(environment) {
  const parsed = JSON.parse(simctl(environment, ["list", "devices", "-j"], { timeout: 60_000 }));
  return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) =>
    (devices ?? []).map(({ name, udid, state, isAvailable }) => ({ name, udid, state, isAvailable: isAvailable !== false, runtime })),
  );
}

function bootedDevices(devices) {
  return devices.filter((device) => device.state === "Booted");
}

/**
 * `-x` matches the executable name, not the command line: a wrapper such as
 * `npm run ios:sim:run -- xcodebuild …` must not look like a second build.
 */
export function xcodebuildProcesses(environment) {
  const result = environment.run(environment.env.MOVIECAL_IOS_SIM_PGREP || "pgrep", ["-x", "xcodebuild"], { timeout: 10_000 });
  return result.stdout
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== environment.pid);
}

/** The device's current state from a one-device `simctl list`, or null when it cannot be read. */
function readDeviceState(environment, udid) {
  try {
    const parsed = JSON.parse(simctl(environment, ["list", "devices", "-j", udid], { timeout: 20_000 }));
    for (const devices of Object.values(parsed.devices ?? {})) {
      const found = (devices ?? []).find((entry) => entry.udid === udid);
      if (found) return found.state;
    }
  } catch {
    // an unreadable state is "not confirmed shut down", which the caller handles
  }
  return null;
}

function runShutdown(environment, udid, timeout) {
  const result = environment.run(xcrun(environment), ["simctl", "shutdown", udid], { timeout });
  if (result.status !== 0 && !/current state: Shutdown/iu.test(`${result.stderr}${result.stdout}`)) {
    throw new Error(`Could not shut the simulator ${udid} down: ${(result.stderr || result.stdout).trim()}`);
  }
}

/**
 * MOV-497: `simctl shutdown` exiting 0 does not prove the device stopped (a
 * wedged CoreSimulatorService ignores it), so the state is re-read and polled,
 * the shutdown is retried once, and a device that is still Booted is reported
 * loudly instead of claimed shut down. Returns `{ shutdown, attempts, elapsedMs }`.
 */
function shutdownDevice(environment, device, timeout = 120_000) {
  const startedAt = environment.now();
  const poll = () =>
    pollUntilShutdown({ read: () => readDeviceState(environment, device.udid), now: environment.now, sleep: environment.sleep });

  runShutdown(environment, device.udid, timeout);
  let polled = poll();
  let attempts = 1;
  if (!polled.shutdown) {
    attempts = 2;
    try {
      runShutdown(environment, device.udid, timeout);
    } catch {
      // the verdict comes from the state read below, not from the retry's exit code
    }
    polled = poll();
  }

  const elapsedMs = environment.now() - startedAt;
  if (!polled.shutdown) {
    (environment.stuckDevices ??= new Set()).add(device.udid);
    environment.warn(
      `${STILL_BOOTED_MESSAGE}: ${device.name} (${device.udid}) is still ${polled.state ?? "in an unreadable state"} ` +
        `${formatDuration(elapsedMs)} after ${attempts} shutdown attempts, although \`simctl shutdown\` did not report an error. ` +
        "CoreSimulatorService is probably wedged; see docs/operators/local-execution.md (Wedged simulator service).",
    );
  }
  return { shutdown: polled.shutdown, attempts, elapsedMs };
}

function systemLoadReport(environment, previousCpus = null) {
  try {
    const cpus = environment.cpus();
    const split = cpuSplit(cpus, previousCpus);
    const load = environment.loadavg().map((value) => value.toFixed(2)).join(" ");
    return (
      `load average ${load} on ${cpus.length} cores; CPU ` +
      `${split ? `${split.user}% user, ${split.system}% system, ${split.idle}% idle` : "split unavailable"} ` +
      `(${previousCpus ? "over the capture" : "since boot"})`
    );
  } catch (error) {
    return `load and CPU unavailable: ${error.message}`;
  }
}

// --------------------------------------------------------- setup / acquire

export function commandSetup(options, environment) {
  const devices = listDevices(environment);
  const runtimes = JSON.parse(simctl(environment, ["list", "runtimes", "-j"], { timeout: 60_000 })).runtimes ?? [];
  const { runtime, plan } = resolveSetupPlan({ devices, runtimes });

  environment.log(`iOS simulator lane devices (runtime ${runtime}):`);
  const results = plan.map((entry) => {
    if (entry.action === "existing") {
      environment.log(`  ${entry.name.padEnd(16)} ${entry.udid}  (already exists — left exactly as it is)`);
      return entry;
    }
    const udid = simctl(environment, ["create", entry.name, entry.deviceType, entry.runtime], { timeout: 300_000 }).trim();
    environment.log(`  ${entry.name.padEnd(16)} ${udid}  (created)`);
    return { ...entry, action: "created", udid };
  });
  environment.log(`The shared ${SHARED_DEVICE_NAME} device is never created, modified, or deleted by this command.`);
  return results;
}

/** One guarded attempt at taking the lease; the caller runs it inside the mutex. */
function claimLease({ environment, lane, id, holder, options }) {
  const record = environment.store.load();
  const nowMs = environment.now();
  pruneWaiters(record, environment.isProcessAlive);
  const liveness = leaseLiveness(record.lease, { nowMs, isProcessAlive: environment.isProcessAlive });
  const save = (outcome) => {
    environment.store.save(record);
    return outcome;
  };

  // A holder re-entering its own live lease renews it instead of deadlocking
  // behind itself (nested `ios:sim:run`, a second acquire in the same job).
  // A dispatcher-held worker lease is a second, explicit form of the same
  // reentrancy: the lease id is handed to the worker as
  // MOVIECAL_IOS_SIM_LEASE_ID, so `ios:sim:run` inside that worker's own
  // (different) process recognizes and renews the lease it was handed rather
  // than queueing behind its own dispatcher (MOV-311).
  const reentrant = sameHolder(record.lease?.holder, holder) || (options.reentrantLeaseId && record.lease?.id === options.reentrantLeaseId);
  if (liveness.live && record.lease.lane === lane && reentrant) {
    record.lease = renewLease(record.lease, nowMs);
    removeWaiter(record, id);
    return save({ acquired: true, lease: record.lease, shutdown: [], reused: true });
  }

  enqueueWaiter(record, {
    id, lane, pid: holder.pid, startedAt: holder.startedAt,
    purpose: options.purpose ?? null, since: new Date(nowMs).toISOString(),
  });

  if (liveness.live) {
    const { lane: held, id: heldId, device, expiresAt } = record.lease;
    return save({ acquired: false, reason: "held", detail: `the ${held} lane holds lease ${heldId} on ${device.name} until ${expiresAt}` });
  }
  if (!isHeadWaiter(record, id)) {
    return save({ acquired: false, reason: "queued", detail: `${waiterPosition(record, id)} waiter(s) ahead of this one in the queue` });
  }

  // Lazy takeover: an expired/stale lease is only torn down now, because a
  // waiter (this process) actually exists.
  const previous = record.lease;
  const devices = listDevices(environment);
  const wanted = laneDevice(lane);
  const device = devices.find((candidate) => candidate.name === wanted);
  if (!device) {
    environment.store.save(record);
    throw new Error(`The ${wanted} simulator does not exist. Run \`npm run ios:sim:setup\` first.`);
  }

  // MOV-493: a CI job starts from a known state. With no live lease, a booted
  // `moviecal-*` lane device (for example a forgotten `moviecal-manual`) is
  // leftover, not someone's session, so it is shut down instead of waited on.
  const staleOthers = lane === "ci" ? selectStaleLaneDevices(bootedDevices(devices), [previous?.device?.udid]) : [];
  // MOV-497: no live lease exists here, so the job's own device being Booted is
  // leftover too. It is shut down (and verified) so a wedged service is caught
  // now rather than as a hang in `bootstatus`.
  const ownLeftover = lane === "ci" && device.state === "Booted" ? [device] : [];
  const stale = [...staleOthers.filter((entry) => entry.udid !== device.udid), ...ownLeftover];
  const staleUdids = new Set(stale.map((entry) => entry.udid));
  const unmanaged = unmanagedState({
    bootedDevices: bootedDevices(devices).filter((entry) => !staleUdids.has(entry.udid)),
    xcodebuildProcesses: xcodebuildProcesses(environment),
    ownedUdids: [previous?.device?.udid],
  });
  if (unmanaged.unmanaged && !options.forceShutdownUnmanaged) {
    return save({ acquired: false, reason: "unmanaged", detail: describeUnmanaged(unmanaged) });
  }

  record.lease = createLease({
    lane, id, holder, purpose: options.purpose, ref: options.ref,
    device: { name: device.name, udid: device.udid }, nowMs,
  });
  removeWaiter(record, id);
  return save({
    acquired: true,
    lease: record.lease,
    takeover: previous ? { lease: previous, reason: liveness.reason } : null,
    shutdown: [...bootedDevices(devices).filter((candidate) => candidate.udid !== device.udid), ...ownLeftover],
    stale,
  });
}

function forgetWaiter(environment, id) {
  try {
    withMutex(environment, () => {
      const record = environment.store.load();
      if (removeWaiter(record, id)) environment.store.save(record);
    });
  } catch {
    // a waiter entry whose process is gone is pruned by the next acquirer anyway
  }
}

function finishAcquire(attempt, environment, lane) {
  const { lease, takeover } = attempt;
  if (takeover) environment.log(`Took over the ${takeover.lease.lane} lease ${takeover.lease.id} (${takeover.reason}).`);
  const staleUdids = new Set((attempt.stale ?? []).map((device) => device.udid));
  const stuck = [];
  for (const device of attempt.shutdown ?? []) {
    environment.log(
      staleUdids.has(device.udid)
        ? `Start-of-job cleanup: shutting down leftover simulator ${device.name} (${device.udid}), which no lease owns. Its data is not deleted.`
        : `Shutting ${device.name} (${device.udid}) down so only one simulator stays booted.`,
    );
    if (!shutdownDevice(environment, device).shutdown) stuck.push(device);
  }
  if (stuck.length > 0) {
    environment.warn(`--- system load ---\n${systemLoadReport(environment)}`);
    throw new ServiceUnresponsiveError(
      `${stuck.map((device) => `${device.name} (${device.udid})`).join(", ")} stayed Booted after shutdown, so the simulator ` +
        "service is not responding. Failing now instead of waiting on bootstatus. The lease is released. " +
        "This is an infrastructure fault, not a test failure; see docs/operators/local-execution.md (Wedged simulator service).",
    );
  }
  simctl(environment, ["bootstatus", lease.device.udid, "-b"], { timeout: BOOTSTATUS_TIMEOUT_MS });

  environment.log(
    lane === "manual"
      ? agentGuidance(lease)
      : `Acquired the ${lane} simulator lease ${lease.id} on ${lease.device.name} (${lease.device.udid}).`,
  );
  if (!attempt.reused) environment.spawnWatcher?.(lease, environment);
}

export function commandAcquire(options, environment) {
  const lane = detectLane(environment.env);
  const id = options.id ?? randomUUID();
  const holder = { pid: environment.pid, startedAt: environment.processStartTime(environment.pid) };
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS[lane];
  const pollMs = Number(environment.env.MOVIECAL_IOS_SIM_POLL_MS ?? DEFAULT_POLL_MS);
  const deadline = environment.now() + waitMs;
  // MOV-311: a lease id handed down via the environment (the dispatcher to
  // its own worker) is this process's to renew, even though its holder
  // pid/startedAt cannot match the dispatcher's -- see claimLease().
  const reentrantLeaseId = environment.env.MOVIECAL_IOS_SIM_LEASE_ID || null;
  const claimOptions = { ...options, reentrantLeaseId };
  let announced = null;

  for (;;) {
    let attempt;
    try {
      attempt = withMutex(environment, () => claimLease({ environment, lane, id, holder, options: claimOptions }));
    } catch (error) {
      forgetWaiter(environment, id);
      throw error;
    }

    if (attempt.acquired) {
      try {
        finishAcquire(attempt, environment, lane);
      } catch (error) {
        commandRelease({ id: attempt.lease.id, force: true, keepBooted: true }, environment);
        throw error;
      }
      return attempt.lease;
    }

    if (environment.now() >= deadline) {
      forgetWaiter(environment, id);
      throw new LeaseUnavailableError(
        `${attempt.detail}. Waited ${formatDuration(waitMs)}; this is an infrastructure wait, not a test failure — safe to re-run.`,
      );
    }

    if (announced !== attempt.reason) {
      announced = attempt.reason;
      environment.warn(`Waiting for the iOS simulator lease — ${attempt.detail}.`);
      if (attempt.reason === "unmanaged") {
        environment.warn(
          "Unmanaged simulator use is never shut down automatically. Run `npm run ios:sim:adopt` to record it as a " +
            "manual lease, or re-run with --force-shutdown-unmanaged only if you know nobody is testing.",
        );
      }
      environment.notify("iOS simulator lease", `${lane} lane is waiting — ${attempt.detail}.`);
    }
    environment.sleep(pollMs);
  }
}

// --------------------------------------- release / extend / status / adopt

export function commandRelease(options, environment) {
  const lane = detectLane(environment.env);
  const outcome = withMutex(environment, () => {
    const record = environment.store.load();
    if (!record.lease) return { released: false, reason: "no-lease" };
    if (options.id && record.lease.id !== options.id) return { released: false, reason: "other-lease" };
    if (record.lease.lane !== lane && !options.force) {
      throw new Error(
        `The current lease belongs to the ${record.lease.lane} lane and this process is in the ${lane} lane. ` +
          "Re-run with --force only if you are certain it is abandoned.",
      );
    }
    const lease = record.lease;
    record.lease = null;
    environment.store.save(record);
    return { released: true, lease };
  });

  if (!outcome.released) {
    environment.log(outcome.reason === "no-lease" ? "No iOS simulator lease is held." : "A different lease is held; nothing released.");
  } else if (options.keepBooted) {
    environment.log(`Released lease ${outcome.lease.id}; ${outcome.lease.device.name} was left booted.`);
  } else {
    const startedAt = environment.now();
    const elapsed = () => formatDuration(environment.now() - startedAt);
    try {
      const result = shutdownDevice(environment, outcome.lease.device, RELEASE_SHUTDOWN_TIMEOUT_MS);
      if (result.shutdown) {
        environment.log(`Released lease ${outcome.lease.id} and shut ${outcome.lease.device.name} down in ${elapsed()}.`);
      } else {
        environment.warn(
          `Released lease ${outcome.lease.id}, but ${outcome.lease.device.name} is still Booted after ${result.attempts} shutdown ` +
            `attempts (${elapsed()}), so it was not shut down. The next CI job's start-of-job cleanup retries it.`,
        );
      }
    } catch (error) {
      environment.warn(
        `Released lease ${outcome.lease.id}, but shutting ${outcome.lease.device.name} down did not finish within ` +
          `${formatDuration(RELEASE_SHUTDOWN_TIMEOUT_MS)} (gave up after ${elapsed()}): ${error.message} ` +
          "The next CI job's start-of-job cleanup shuts any leftover lane simulator down.",
      );
    }
  }
  return outcome;
}

export function commandExtend(options, environment) {
  const lane = detectLane(environment.env);
  return withMutex(environment, () => {
    const record = environment.store.load();
    if (!record.lease) throw new Error("No iOS simulator lease is held.");
    if (record.lease.lane !== lane && !options.force) {
      throw new Error(`The current lease belongs to the ${record.lease.lane} lane; this process is in the ${lane} lane.`);
    }
    record.lease = renewLease(record.lease, environment.now());
    environment.store.save(record);
    const { id, expiresAt, hardCapAt } = record.lease;
    environment.log(`Lease ${id} now expires at ${expiresAt}${hardCapAt ? ` (hard cap ${hardCapAt}).` : "."}`);
    return record.lease;
  });
}

export function commandStatus(options, environment) {
  const record = environment.store.load();
  const nowMs = environment.now();
  const liveness = leaseLiveness(record.lease, { nowMs, isProcessAlive: environment.isProcessAlive });

  let devices = [];
  let builds = [];
  try {
    devices = listDevices(environment);
    builds = xcodebuildProcesses(environment);
  } catch (error) {
    environment.warn(`Could not read simulator state: ${error.message}`);
  }

  const swap = environment.run("sysctl", ["-n", "vm.swapusage"], { timeout: 10_000 });
  const pressure = environment.run("memory_pressure", ["-Q"], { timeout: 10_000 });
  const lease = record.lease;
  const snapshot = {
    lane: detectLane(environment.env),
    lease,
    live: liveness.live,
    reason: liveness.reason,
    waiters: record.waiters.map((waiter) => ({ ...waiter, waitingFor: formatDuration(nowMs - Date.parse(waiter.since)) })),
    booted: bootedDevices(devices),
    xcodebuild: builds,
    unmanaged: unmanagedState({
      bootedDevices: bootedDevices(devices), xcodebuildProcesses: builds,
      ownedUdids: [liveness.live ? lease.device.udid : null], hasLiveLease: liveness.live,
    }),
    memory: {
      swap: swap.status === 0 ? swap.stdout.trim() : null,
      pressure: pressure.status === 0 ? pressure.stdout.trim().split("\n").at(-1) : null,
    },
  };

  if (options.json) {
    environment.log(JSON.stringify(snapshot, null, 2));
    return snapshot;
  }

  const lines = [`This process is in the ${snapshot.lane} lane.`];
  lines.push(
    ...(lease
      ? [
          `Lease: ${lease.id} (${lease.lane} lane, ${liveness.live ? "live" : describeNotLive(lease, liveness.reason)})`,
          `  device:   ${lease.device.name} (${lease.device.udid})`,
          `  holder:   pid ${lease.holder?.pid ?? "unknown"}${lease.purpose ? ` — ${lease.purpose}` : ""}`,
          ...(lease.ref ? [`  ref:      ${lease.ref}`] : []),
          `  acquired: ${lease.acquiredAt}`,
          `  expires:  ${lease.expiresAt}${liveness.live ? ` (in ${formatDuration(Date.parse(lease.expiresAt) - nowMs)})` : ""}`,
          ...(lease.hardCapAt ? [`  hard cap: ${lease.hardCapAt}`] : []),
        ]
      : ["Lease: none held."]),
    snapshot.waiters.length === 0
      ? "Waiters: none."
      : `Waiters (FIFO): ${snapshot.waiters.map((waiter) => `${waiter.lane} pid ${waiter.pid} waiting ${waiter.waitingFor}`).join("; ")}`,
    snapshot.booted.length === 0
      ? "Booted simulators: none."
      : `Booted simulators: ${snapshot.booted.map((entry) => `${entry.name} (${entry.udid})`).join(", ")}`,
    ...(builds.length > 0 ? [`Running xcodebuild pids: ${builds.join(", ")}`] : []),
    ...(snapshot.unmanaged.unmanaged ? [`Unmanaged: ${describeUnmanaged(snapshot.unmanaged)}`] : []),
    `Memory: ${snapshot.memory.swap ?? "swap unavailable"}${snapshot.memory.pressure ? ` | ${snapshot.memory.pressure}` : ""}`,
  );
  for (const line of lines) environment.log(line);
  return snapshot;
}

export function commandAdopt(options, environment) {
  if (detectLane(environment.env) !== "manual") {
    throw new Error("`ios:sim:adopt` records a human's simulator session and only runs in the manual lane.");
  }

  const lease = withMutex(environment, () => {
    const record = environment.store.load();
    const nowMs = environment.now();
    if (leaseLiveness(record.lease, { nowMs, isProcessAlive: environment.isProcessAlive }).live) {
      throw new Error(`A live ${record.lease.lane} lease already covers ${record.lease.device.name}.`);
    }

    const booted = bootedDevices(listDevices(environment));
    const chosen = options.device
      ? booted.find((device) => device.udid === options.device || device.name === options.device)
      : (booted.length === 1 ? booted[0] : null);
    if (!chosen) {
      throw new Error(
        booted.length === 0
          ? "No booted simulator to adopt."
          : "Several simulators are booted; pass --device <udid|name> to say which one to adopt.",
      );
    }

    record.lease = createLease({
      lane: "manual",
      id: options.id ?? randomUUID(),
      holder: { pid: environment.pid, startedAt: environment.processStartTime(environment.pid) },
      purpose: options.purpose ?? "adopted unmanaged simulator use",
      ref: options.ref,
      device: { name: chosen.name, udid: chosen.udid },
      nowMs,
    });
    removeWaiter(record, record.lease.id);
    environment.store.save(record);
    return record.lease;
  });

  environment.log(agentGuidance(lease));
  environment.spawnWatcher?.(lease, environment);
  return lease;
}

// -------------------------------------------------------------- run / watch

function renewHeldLease(environment, id) {
  try {
    withMutex(environment, () => {
      const record = environment.store.load();
      if (record.lease?.id !== id) return;
      record.lease = renewLease(record.lease, environment.now());
      environment.store.save(record);
    });
  } catch {
    // a missed renewal is recovered by the next tick, or by expiry as designed
  }
}

/** Best-effort, bounded evidence for a stalled simulator; never throws. */
export async function captureSimulatorDiagnostics(environment, lease) {
  const capMs = environment.diagnosticsCapMs ?? DIAGNOSTICS_TOTAL_CAP_MS;
  const sections = [
    [`device state (${lease.device.name} ${lease.device.udid})`, xcrun(environment), ["simctl", "list", "devices", lease.device.udid], 20_000],
    ["simctl list", xcrun(environment), ["simctl", "list"], 30_000],
    [
      "recent CoreSimulator log lines",
      "log",
      ["show", "--last", "10m", "--style", "compact", "--predicate", 'subsystem == "com.apple.CoreSimulator"'],
      45_000,
    ],
  ];

  // Commands run concurrently; each fills its own slot, so a hung one cannot
  // hold back the others, and the cap abandons whatever has not finished.
  const results = sections.map(() => null);
  const tasks = sections.map(async ([, command, args, timeout], index) => {
    try {
      results[index] = await environment.runAsync(command, args, { timeout });
    } catch (error) {
      results[index] = { error: error.message };
    }
  });
  let cpuBefore = null;
  let cpuAfter = null;
  try {
    cpuBefore = environment.cpus();
    tasks.push(
      (async () => {
        await environment.delay(500);
        cpuAfter = environment.cpus();
      })().catch(() => {}),
    );
  } catch {
    // CPU numbers are optional evidence
  }

  let capTimer;
  const capped = new Promise((resolve) => {
    capTimer = setTimeout(resolve, capMs);
  });
  await Promise.race([Promise.all(tasks), capped]);
  clearTimeout(capTimer);

  try {
    environment.warn(`--- system load ---\n${systemLoadReport(environment, cpuAfter ? cpuBefore : null)}`);
    sections.forEach(([title], index) => {
      const result = results[index];
      if (!result) {
        environment.warn(`--- ${title}: still running at the ${formatDuration(capMs)} diagnostics cap; abandoned ---`);
      } else if (result.error) {
        environment.warn(`--- ${title}: could not be captured: ${result.error} ---`);
      } else {
        const output = `${result.stdout}${result.stderr}`.trim().split("\n");
        const shown = title.startsWith("recent") ? output.slice(-60) : output;
        environment.warn(`--- ${title} (exit ${result.status}) ---\n${shown.join("\n")}`);
      }
    });
    if (environment.stuckDevices?.size > 0) {
      environment.warn(
        "--- hint ---\nA simulator did not shut down when asked. CoreSimulatorService is the likely culprit; " +
          "see docs/operators/local-execution.md (Wedged simulator service) for the manual recovery.",
      );
    }
  } catch (error) {
    environment.warn(`--- diagnostics could not be reported: ${error.message} ---`);
  }
}

export async function commandRun(options, environment) {
  if (options.commandArgs.length === 0) throw new Error("`ios:sim:run` needs a command: npm run ios:sim:run -- <command…>");
  const lease = commandAcquire({ ...options, purpose: options.purpose ?? options.commandArgs.join(" ") }, environment);
  // MOV-311: a lease this process was handed (not one it originated) is being
  // renewed, not owned -- releasing it here would tear down a dispatcher's
  // still-running worker lease out from under it. Only the process that
  // actually created a lease id, by acquiring it itself, ever releases it.
  const reentrant = Boolean(environment.env.MOVIECAL_IOS_SIM_LEASE_ID) && environment.env.MOVIECAL_IOS_SIM_LEASE_ID === lease.id;

  let released = false;
  const release = () => {
    if (released || reentrant) return;
    released = true;
    try {
      commandRelease({ id: lease.id, force: true, keepBooted: options.keepBooted }, environment);
    } catch (error) {
      environment.warn(`Could not release lease ${lease.id}: ${error.message}`);
    }
  };

  // Handlers are installed before the command starts so an interrupt landing in
  // the spawn window still reaches the child and still releases.
  let child = null;
  let interrupted = null;
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => {
      interrupted = signal;
      try {
        child?.kill(signal);
      } catch {
        // the child may already be gone; the release below still runs
      }
    };
    process.on(signal, handler);
    return [signal, handler];
  });

  const progressLimitMs = options.progressWithinMs ?? (options.earlyProgress ? EARLY_PROGRESS_LIMIT_MS : null);
  const idleLimitMs = options.idleWithinMs ?? (progressLimitMs === null ? null : OUTPUT_IDLE_LIMIT_MS);
  const startedAtMs = environment.now();
  const watch = progressLimitMs === null ? null : createProgressWatch({ limitMs: progressLimitMs, startedAtMs });
  const idleWatch = idleLimitMs === null ? null : createIdleWatch({ limitMs: idleLimitMs, startedAtMs });
  const watching = Boolean(watch || idleWatch);

  child = spawn(options.commandArgs[0], options.commandArgs.slice(1), {
    stdio: ["inherit", watching ? "pipe" : "inherit", watching ? "pipe" : "inherit"],
    env: { ...process.env, MOVIECAL_IOS_SIM_DEVICE: lease.device.udid, MOVIECAL_IOS_SIM_LEASE: lease.id },
  });
  if (interrupted) child.kill(interrupted);

  let stalled = null;
  let stallTimer = null;
  let killTimer = null;
  if (watching) {
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      watch?.onOutput(chunk);
      idleWatch?.onOutput(chunk, environment.now(), "stdout");
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      idleWatch?.onOutput(chunk, environment.now(), "stderr");
    });
    const pollMs = Number(environment.env.MOVIECAL_IOS_SIM_PROGRESS_POLL_MS ?? 5_000);
    stallTimer = setInterval(async () => {
      if (stalled) return;
      const nowMs = environment.now();
      let message;
      if (watch?.expired(nowMs)) {
        stalled = { exitCode: EARLY_PROGRESS_EXIT_CODE };
        message =
          `${EARLY_PROGRESS_MESSAGE}: no test suite started within ${formatDuration(progressLimitMs)} of the simulator booting. ` +
          "Failing now instead of waiting out the step timeout; capturing simulator diagnostics, then releasing the lease.";
      } else if (idleWatch?.expired(nowMs)) {
        stalled = { exitCode: OUTPUT_IDLE_EXIT_CODE };
        const last = idleWatch.lastOutputAtMs === null ? "never (no output since the command started)" : new Date(idleWatch.lastOutputAtMs).toISOString();
        message =
          `${OUTPUT_IDLE_MESSAGE}: no output for ${formatDuration(idleLimitMs)}. Last output at ${last}; ` +
          `last suite/test line: ${idleWatch.lastLine ?? "none seen"}. This is a stalled simulator, not a test failure; ` +
          "re-run the job. Capturing simulator diagnostics, then releasing the lease.";
      } else {
        return;
      }
      environment.warn(message);
      if (stalled.exitCode === OUTPUT_IDLE_EXIT_CODE && environment.env.GITHUB_ACTIONS === "true") {
        environment.warn(`::error title=${OUTPUT_IDLE_MESSAGE}::${message.split(". Capturing")[0]}`);
      }
      await captureSimulatorDiagnostics(environment, lease);
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, pollMs);
  }

  // The lease must survive a long build even if the detached watcher died, so
  // this process renews it directly while its command runs.
  const heartbeat = setInterval(() => renewHeldLease(environment, lease.id), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    const result = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    if (stalled) return stalled.exitCode;
    return result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : (result.code ?? 0);
  } finally {
    clearInterval(heartbeat);
    clearInterval(stallTimer);
    clearTimeout(killTimer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    release();
  }
}

function spawnWatcher(lease, environment) {
  if (environment.env.MOVIECAL_IOS_SIM_WATCHER === "0") return null;
  try {
    const child = spawn(process.execPath, [SCRIPT_PATH, "watch", "--id", lease.id], {
      detached: true, stdio: ["ignore", "inherit", "inherit"], env: { ...environment.env },
    });
    child.unref();
    return child.pid;
  } catch (error) {
    environment.warn(`The lease watcher could not start (notifications only): ${error.message}`);
    return null;
  }
}

/**
 * Best-effort: the watcher never holds the lease, so its death only costs
 * notifications (and, for ci/worker, a heartbeat the holder's own `run` command
 * also refreshes).
 */
export async function commandWatch(options, environment) {
  const interval = Number(environment.env.MOVIECAL_IOS_SIM_WATCH_INTERVAL_MS ?? HEARTBEAT_INTERVAL_MS);
  const announce = (title, message) => {
    environment.log(`${title} — ${message}`);
    environment.notify(title, message);
  };
  let warnedFor = null;
  let announcedWaiters = false;

  for (;;) {
    const record = environment.store.load();
    const lease = record.lease;
    if (lease?.id !== options.id) return 0;
    const nowMs = environment.now();

    if (lease.lane !== "manual") {
      if (!environment.isProcessAlive(lease.holder)) return 0;
      renewHeldLease(environment, options.id);
    } else {
      const expiresAt = Date.parse(lease.expiresAt);
      if (nowMs >= expiresAt) {
        announce(
          "iOS simulator lease expired",
          "The next waiter may take this simulator over. Run `npm run ios:sim:release` when you are finished testing.",
        );
        return 0;
      }
      if (warnedFor !== lease.expiresAt && nowMs >= expiresAt - MANUAL_WARNING_LEAD_MS) {
        warnedFor = lease.expiresAt;
        announce(
          "iOS simulator lease expires in 5 minutes",
          "Run `npm run ios:sim:extend` to renew (never past the 60-minute cap), or `npm run ios:sim:release` when done.",
        );
      }
      if (!announcedWaiters && record.waiters.length > 0) {
        announcedWaiters = true;
        announce("Someone is waiting for the iOS simulator", `${record.waiters.length} waiter(s) queued. Run \`npm run ios:sim:status\` to see who.`);
      }
    }

    await environment.delay(interval);
  }
}

// ---------------------------------------------------------------------- CLI

const VALUED_FLAGS = { "--purpose": "purpose", "--ref": "ref", "--device": "device", "--id": "id" };
const MINUTE_FLAGS = { "--wait": "waitMs", "--progress-within": "progressWithinMs", "--idle-within": "idleWithinMs" };
const BOOLEAN_FLAGS = {
  "--keep-booted": "keepBooted", "--force-shutdown-unmanaged": "forceShutdownUnmanaged",
  "--force": "force", "--json": "json", "--early-progress": "earlyProgress",
};

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`Usage: ios-sim-lease.mjs <${COMMANDS.join("|")}> [options]`);

  const options = {
    command, purpose: null, ref: null, waitMs: null, progressWithinMs: null, idleWithinMs: null, earlyProgress: false, keepBooted: false,
    forceShutdownUnmanaged: false, force: false, json: false, device: null, id: null, commandArgs: [],
  };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (command === "run" && (argument === "--" || !argument.startsWith("-"))) {
      options.commandArgs = rest.slice(argument === "--" ? index + 1 : index);
      break;
    }
    if (argument === "--lane") {
      throw new Error("The simulator lane is derived from the environment (GITHUB_ACTIONS, MOVIECAL_WORKER_SANDBOX) and cannot be set with a flag.");
    }
    if (BOOLEAN_FLAGS[argument]) {
      options[BOOLEAN_FLAGS[argument]] = true;
      continue;
    }
    if (!VALUED_FLAGS[argument] && !MINUTE_FLAGS[argument]) throw new Error(`Unknown argument: ${argument}`);
    const value = rest[++index];
    if (value === undefined) throw new Error(`${argument} requires a value.`);
    if (!MINUTE_FLAGS[argument]) {
      options[VALUED_FLAGS[argument]] = value;
      continue;
    }
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`${argument} takes a number of minutes.`);
    options[MINUTE_FLAGS[argument]] = minutes * MINUTE_MS;
  }

  if (command === "watch" && !options.id) throw new Error("watch requires --id <lease id>.");
  return options;
}

const SYNCHRONOUS = {
  setup: commandSetup, acquire: commandAcquire, release: commandRelease,
  extend: commandExtend, status: commandStatus, adopt: commandAdopt,
};

export async function runCli(argv, environment = createEnvironment()) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    environment.warn(error.message);
    return 1;
  }

  try {
    if (options.command === "run") return await commandRun(options, environment);
    if (options.command === "watch") return await commandWatch(options, environment);
    SYNCHRONOUS[options.command](options, environment);
    return 0;
  } catch (error) {
    environment.warn(error.message);
    return error.exitCode ?? 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runCli(process.argv.slice(2));
}
