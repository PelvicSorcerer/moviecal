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

function shutdownDevice(environment, udid) {
  const result = environment.run(xcrun(environment), ["simctl", "shutdown", udid], { timeout: 120_000 });
  if (result.status !== 0 && !/current state: Shutdown/iu.test(`${result.stderr}${result.stdout}`)) {
    throw new Error(`Could not shut the simulator ${udid} down: ${(result.stderr || result.stdout).trim()}`);
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

  const unmanaged = unmanagedState({
    bootedDevices: bootedDevices(devices),
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
    shutdown: bootedDevices(devices).filter((candidate) => candidate.udid !== device.udid),
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
  for (const device of attempt.shutdown ?? []) {
    environment.log(`Shutting ${device.name} (${device.udid}) down so only one simulator stays booted.`);
    shutdownDevice(environment, device.udid);
  }
  simctl(environment, ["bootstatus", lease.device.udid, "-b"], { timeout: 600_000 });

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
    shutdownDevice(environment, outcome.lease.device.udid);
    environment.log(`Released lease ${outcome.lease.id} and shut ${outcome.lease.device.name} down.`);
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
          `Lease: ${lease.id} (${lease.lane} lane, ${liveness.live ? "live" : `not live — ${liveness.reason}`})`,
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

  child = spawn(options.commandArgs[0], options.commandArgs.slice(1), {
    stdio: "inherit",
    env: { ...process.env, MOVIECAL_IOS_SIM_DEVICE: lease.device.udid, MOVIECAL_IOS_SIM_LEASE: lease.id },
  });
  if (interrupted) child.kill(interrupted);

  // The lease must survive a long build even if the detached watcher died, so
  // this process renews it directly while its command runs.
  const heartbeat = setInterval(() => renewHeldLease(environment, lease.id), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    const result = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    return result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : (result.code ?? 0);
  } finally {
    clearInterval(heartbeat);
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
const BOOLEAN_FLAGS = {
  "--keep-booted": "keepBooted", "--force-shutdown-unmanaged": "forceShutdownUnmanaged",
  "--force": "force", "--json": "json",
};

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`Usage: ios-sim-lease.mjs <${COMMANDS.join("|")}> [options]`);

  const options = {
    command, purpose: null, ref: null, waitMs: null, keepBooted: false,
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
    if (!VALUED_FLAGS[argument] && argument !== "--wait") throw new Error(`Unknown argument: ${argument}`);
    const value = rest[++index];
    if (value === undefined) throw new Error(`${argument} requires a value.`);
    if (argument !== "--wait") {
      options[VALUED_FLAGS[argument]] = value;
      continue;
    }
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error("--wait takes a number of minutes.");
    options.waitMs = minutes * MINUTE_MS;
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
