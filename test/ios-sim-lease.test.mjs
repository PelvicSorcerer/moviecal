import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HardCapError, LANE_DEVICES, LeaseStore, LeaseUnavailableError, MANUAL_HARD_CAP_MS, MANUAL_LEASE_MS,
  SHARED_DEVICE_NAME, UNAVAILABLE_EXIT_CODE, UNAVAILABLE_MESSAGE, agentGuidance, commandAcquire, commandAdopt,
  commandExtend, commandRelease, commandRun, commandSetup, commandStatus, commandWatch, createEnvironment, createLease,
  detectLane, emptyRecord, enqueueWaiter, isHeadWaiter, laneDevice, leaseLiveness, leasePath, parseArguments,
  pruneWaiters, renewLease, resolveSetupPlan, unmanagedState, waiterPosition, withMutex,
  EARLY_PROGRESS_EXIT_CODE, EARLY_PROGRESS_LIMIT_MS, RELEASE_SHUTDOWN_TIMEOUT_MS, createProgressWatch, selectStaleLaneDevices,
  SERVICE_UNRESPONSIVE_EXIT_CODE, SHUTDOWN_VERIFY_TIMEOUT_MS, ServiceUnresponsiveError, captureSimulatorDiagnostics, cpuSplit,
  describeNotLive, pollUntilShutdown, runCli,
} from "../scripts/ios-sim-lease.mjs";

const START = Date.parse("2026-09-23T10:00:00.000Z");
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-0";
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "moviecal-ios-sim-lease-"));
  temporaryDirectories.push(directory);
  return directory;
}

function device(name, state = "Shutdown") {
  return { name, udid: `udid-${name}`, state, isAvailable: true, runtime: RUNTIME };
}

/** The shared `iPhone 17` plus the three lane devices, in that order. */
function laneDevices(...states) {
  return [SHARED_DEVICE_NAME, LANE_DEVICES.ci, LANE_DEVICES.worker, LANE_DEVICES.manual].map((name, index) =>
    device(name, states[index] ?? "Shutdown"),
  );
}

/** A scriptable stand-in for `simctl`, `ps`, `pgrep`, and the memory tools. */
function fakeRunner(state, processTable) {
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const fail = (stderr = "") => ({ status: 1, stdout: "", stderr });

  return (command, args) => {
    if (command === "ps") {
      const value = processTable.get(Number(args.at(-1)));
      return value ? ok(`${value}\n`) : fail();
    }
    if (command === "pgrep") return state.xcodebuild.length > 0 ? ok(state.xcodebuild.join("\n")) : fail();
    if (command === "sysctl") return ok("total = 3072.00M  used = 1900.00M  free = 1172.00M\n");
    if (command === "memory_pressure") return ok("System-wide memory free percentage: 42%\n");
    if (command === "osascript") return ok();
    if (command !== "xcrun" || args[0] !== "simctl") return fail(`unexpected command ${command}`);

    const [, subcommand, ...rest] = args;
    if (subcommand === "list" && rest[0] === "runtimes") return ok(JSON.stringify({ runtimes: state.runtimes }));
    if (subcommand === "list" && rest[0] === "devices") {
      const grouped = {};
      for (const entry of state.devices) {
        if (entry.pendingReads !== undefined && (entry.pendingReads -= 1) <= 0) {
          entry.state = "Shutdown";
          delete entry.pendingReads;
        }
        (grouped[entry.runtime] ??= []).push({ ...entry });
      }
      return ok(JSON.stringify({ devices: grouped }));
    }
    if (subcommand === "create") {
      const created = { ...device(rest[0]), runtime: rest[2] };
      state.devices.push(created);
      return ok(`${created.udid}\n`);
    }
    const target = state.devices.find((entry) => entry.udid === rest[0]);
    if (!target) return fail("Invalid device");
    if (subcommand === "bootstatus") {
      target.state = "Booted";
      return ok();
    }
    if (subcommand === "shutdown") {
      if (target.state !== "Booted") return fail("Unable to shutdown device in current state: Shutdown");
      // A wedged service: exits 0 but the device stays Booted (forever, or until N more state reads).
      if (state.wedged === true) return ok();
      if (typeof state.wedged === "number") {
        target.pendingReads = state.wedged;
        return ok();
      }
      target.state = "Shutdown";
      return ok();
    }
    return fail(`unexpected simctl ${subcommand}`);
  };
}

/**
 * One simulated process, with an injected clock, process table, and simulator
 * inventory. Pass `world` to put a second process in the same machine: it
 * shares the state directory, the devices, and the process table.
 */
function harness({ env = {}, devices = [], xcodebuild = [], pid = process.pid, world } = {}) {
  const directory = world?.directory ?? temporaryDirectory();
  const state = world?.state ?? {
    devices: devices.map((entry) => ({ ...entry })),
    runtimes: [{ identifier: RUNTIME, version: "26.0", isAvailable: true }],
    xcodebuild: [...xcodebuild],
  };
  const table = world?.table ?? new Map();
  table.set(pid, `start-${pid}`);
  const logs = [];
  const warnings = [];
  const notifications = [];
  let nowMs = world ? world.at() : START;

  const environment = createEnvironment({
    env: { MOVIECAL_IOS_SIM_STATE_DIR: directory, MOVIECAL_IOS_SIM_WATCHER: "0", ...env },
    pid,
    run: fakeRunner(state, table),
    now: () => nowMs,
    sleep: (ms) => {
      nowMs += ms;
    },
    // The watcher's wait is the only thing that moves its clock, so an injected
    // delay turns a 20-minute lease into a handful of synchronous iterations.
    delay: (ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    notify: (title, message) => notifications.push(`${title}: ${message}`),
    processStartTime: (target) => table.get(target) ?? null,
    isProcessAlive: (holder) => table.has(holder.pid) && (!holder.startedAt || table.get(holder.pid) === holder.startedAt),
    spawnWatcher: () => null,
    runAsync: (command, args, options) => Promise.resolve(environment.run(command, args, options)),
    loadavg: () => [570.1, 400.25, 120.5],
    cpus: () => [{ times: { user: 700, nice: 0, sys: 200, idle: 100, irq: 0 } }],
  });

  return {
    environment, state, table, directory, logs, warnings, notifications,
    output: () => logs.join("\n"),
    booted: () => state.devices.filter((entry) => entry.state === "Booted").map((entry) => entry.name),
    advance: (ms) => {
      nowMs += ms;
    },
    at: () => nowMs,
  };
}

describe("simulator lane detection", () => {
  it("derives ci, worker, and manual from the environment alone", () => {
    expect(detectLane({ GITHUB_ACTIONS: "true" })).toBe("ci");
    expect(detectLane({ MOVIECAL_WORKER_SANDBOX: "1" })).toBe("worker");
    expect(detectLane({})).toBe("manual");
    // An interactive agent session working for a human is deliberately manual.
    expect(detectLane({ CLAUDECODE: "1", TERM_PROGRAM: "iTerm.app" })).toBe("manual");
    expect(detectLane({ GITHUB_ACTIONS: "true", MOVIECAL_WORKER_SANDBOX: "1" })).toBe("ci");
  });

  it("cannot be overridden by a CLI flag", () => {
    expect(() => parseArguments(["acquire", "--lane", "ci"])).toThrow(/derived from the environment/iu);
    expect(() => parseArguments(["acquire", "--lane=ci"])).toThrow(/Unknown argument/u);
  });

  it("maps each lane to its own dedicated device", () => {
    expect([laneDevice("ci"), laneDevice("worker"), laneDevice("manual")]).toEqual([
      "moviecal-ci", "moviecal-worker", "moviecal-manual",
    ]);
  });
});

describe("the durable lease record", () => {
  it("round-trips and recovers a corrupt primary from its backup", () => {
    const store = new LeaseStore(leasePath({ MOVIECAL_IOS_SIM_STATE_DIR: temporaryDirectory() }));
    expect(store.load()).toEqual(emptyRecord());

    const record = emptyRecord();
    record.lease = createLease({
      lane: "manual", id: "lease-a", holder: { pid: 4242, startedAt: "start-4242" },
      device: { name: LANE_DEVICES.manual, udid: "udid-manual" }, nowMs: START,
    });
    store.save(record);
    store.save({ ...record, lease: { ...record.lease, id: "lease-b" } });

    expect(store.load().lease.id).toBe("lease-b");
    writeFileSync(store.file, "{ not json");
    expect(store.load().lease.id).toBe("lease-a");
  });

  it("serializes read-modify-write behind the mutex and leaves no lock behind", () => {
    const { environment } = harness();
    for (const [id, lane] of [["one", "manual"], ["two", "ci"]]) {
      withMutex(environment, () => {
        const record = environment.store.load();
        record.waiters.push({ id, lane, pid: 1, since: new Date(START).toISOString() });
        environment.store.save(record);
      });
    }

    expect(environment.store.load().waiters.map((waiter) => waiter.id)).toEqual(["one", "two"]);
    expect(() => readFileSync(environment.mutexFile, "utf8")).toThrow();
  });
});

describe("expiry math", () => {
  const manual = () =>
    createLease({
      lane: "manual", id: "lease-manual", holder: { pid: 99, startedAt: "start-99" },
      device: { name: LANE_DEVICES.manual, udid: "udid-manual" }, nowMs: START,
    });

  it("gives a manual lease 20 minutes and a 60-minute hard cap", () => {
    const lease = manual();
    expect(Date.parse(lease.expiresAt) - START).toBe(MANUAL_LEASE_MS);
    expect(Date.parse(lease.hardCapAt) - START).toBe(MANUAL_HARD_CAP_MS);
    expect(leaseLiveness(lease, { nowMs: START + MANUAL_LEASE_MS - 1 })).toMatchObject({ live: true });
    expect(leaseLiveness(lease, { nowMs: START + MANUAL_LEASE_MS })).toMatchObject({ live: false, reason: "expired" });
  });

  it("renews to now + 20 minutes but never past the hard cap", () => {
    const lease = manual();
    const renewed = renewLease(lease, START + 15 * 60_000);
    expect(Date.parse(renewed.expiresAt)).toBe(START + 35 * 60_000);
    expect(Date.parse(renewLease(renewed, START + 55 * 60_000).expiresAt)).toBe(Date.parse(lease.hardCapAt));
  });

  it("refuses to renew past the hard cap and says to release instead", () => {
    const capped = () => renewLease(manual(), START + MANUAL_HARD_CAP_MS);
    expect(capped).toThrow(HardCapError);
    expect(capped).toThrow(/ios:sim:release/u);
    expect(capped).toThrow(/queues behind any waiters/u);
  });

  it("expires ci and worker leases by pid liveness plus heartbeat", () => {
    const lease = createLease({
      lane: "ci", id: "lease-ci", holder: { pid: 500, startedAt: "start-500" },
      device: { name: LANE_DEVICES.ci, udid: "udid-ci" }, nowMs: START,
    });
    const alive = (holder) => holder.pid === 500 && holder.startedAt === "start-500";

    expect(leaseLiveness(lease, { nowMs: START + 60_000, isProcessAlive: alive })).toMatchObject({ live: true });
    expect(leaseLiveness(lease, { nowMs: START + 4 * 60_000, isProcessAlive: alive })).toMatchObject({ live: false, reason: "heartbeat-stale" });
    expect(leaseLiveness(renewLease(lease, START + 2 * 60_000), { nowMs: START + 3 * 60_000, isProcessAlive: alive })).toMatchObject({ live: true });
    expect(leaseLiveness(lease, { nowMs: START + 60_000, isProcessAlive: () => false })).toMatchObject({ live: false, reason: "holder-gone" });
    // A recycled pid is not the original holder.
    expect(leaseLiveness(lease, { nowMs: START + 60_000, isProcessAlive: (holder) => holder.startedAt === "start-later" }))
      .toMatchObject({ live: false, reason: "holder-gone" });
  });
});

describe("FIFO waiters and unmanaged use", () => {
  it("keeps arrival order, reports position, and prunes dead waiters", () => {
    const record = emptyRecord();
    const waiter = (id, pid) => ({ id, pid, lane: "manual", since: new Date(START).toISOString() });

    for (const [id, pid] of [["first", 11], ["second", 12], ["third", 13]]) enqueueWaiter(record, waiter(id, pid));
    enqueueWaiter(record, { ...waiter("first", 11), purpose: "re-registered" });

    expect(record.waiters.map((entry) => entry.id)).toEqual(["first", "second", "third"]);
    expect(isHeadWaiter(record, "first")).toBe(true);
    expect(waiterPosition(record, "third")).toBe(2);
    expect(pruneWaiters(record, (entry) => entry.pid !== 11)).toBe(1);
    expect(isHeadWaiter(record, "second")).toBe(true);
  });

  it("treats anything no live lease accounts for as unmanaged manual use", () => {
    const booted = [device(SHARED_DEVICE_NAME, "Booted")];
    expect(unmanagedState({ bootedDevices: booted, xcodebuildProcesses: [777] })).toMatchObject({ unmanaged: true });
    expect(unmanagedState({
      bootedDevices: booted, xcodebuildProcesses: [777],
      ownedUdids: [`udid-${SHARED_DEVICE_NAME}`], hasLiveLease: true,
    })).toMatchObject({ unmanaged: false, devices: [], xcodebuild: [] });
  });
});

describe("ios:sim:setup", () => {
  it("creates the three lane devices idempotently and never touches the shared device", () => {
    const session = harness({ devices: [device(SHARED_DEVICE_NAME), device(LANE_DEVICES.ci)] });

    const first = commandSetup({}, session.environment);
    expect(first.map((entry) => entry.name)).toEqual([LANE_DEVICES.ci, LANE_DEVICES.worker, LANE_DEVICES.manual]);
    expect(first.find((entry) => entry.name === LANE_DEVICES.ci).action).toBe("existing");
    expect(first.every((entry) => typeof entry.udid === "string" && entry.udid.length > 0)).toBe(true);
    expect(session.output()).toContain(`udid-${LANE_DEVICES.manual}`);

    expect(commandSetup({}, session.environment).every((entry) => entry.action === "existing")).toBe(true);
    expect(session.state.devices.filter((entry) => entry.name === SHARED_DEVICE_NAME)).toEqual([device(SHARED_DEVICE_NAME)]);
    expect(session.state.devices).toHaveLength(4);
  });

  it("puts the lane devices on the runtime the shared CI device already uses", () => {
    const { runtime, plan } = resolveSetupPlan({
      devices: [{ name: SHARED_DEVICE_NAME, udid: "shared", runtime: RUNTIME, isAvailable: true }],
      runtimes: [
        { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", version: "18.0", isAvailable: true },
        { identifier: RUNTIME, version: "26.0", isAvailable: true },
      ],
    });
    expect(runtime).toBe(RUNTIME);
    expect(plan.every((entry) => entry.action === "create" && entry.runtime === RUNTIME)).toBe(true);
    expect(plan.some((entry) => entry.name === SHARED_DEVICE_NAME)).toBe(false);
  });
});

describe("ios:sim:acquire", () => {
  it("boots the manual device and prints the agent-guidance block", () => {
    const session = harness({ devices: laneDevices() });
    const lease = commandAcquire({ purpose: "MOV-309 manual test" }, session.environment);

    expect(lease.lane).toBe("manual");
    expect(session.booted()).toEqual([LANE_DEVICES.manual]);
    expect(session.output()).toContain(lease.id);
    expect(session.output()).toContain("20 minutes from now");
    expect(session.output()).toContain("60 minutes from first acquisition");
    expect(session.output()).toContain(
      "If you set this simulator up for the user's manual testing, run `npm run ios:sim:release` as soon as the user says they are finished testing.",
    );
    expect(agentGuidance(lease)).toContain("queues behind any waiters");
  });

  it("queues a second acquirer as a FIFO waiter and fails with the labeled exit code", () => {
    const first = harness({ devices: laneDevices() });
    commandAcquire({ purpose: "holder" }, first.environment);

    const second = harness({ world: first, pid: 90_001 });
    const observed = [];
    second.environment.sleep = (ms) => {
      observed.push(second.environment.store.load());
      second.advance(ms);
    };

    let thrown;
    try {
      commandAcquire({ purpose: "second session", waitMs: 60_000 }, second.environment);
    } catch (error) {
      thrown = error;
    }

    expect(observed[0].waiters).toEqual([expect.objectContaining({ lane: "manual", pid: 90_001, purpose: "second session" })]);
    expect(thrown).toBeInstanceOf(LeaseUnavailableError);
    expect(thrown.exitCode).toBe(UNAVAILABLE_EXIT_CODE);
    expect(thrown.message).toContain(UNAVAILABLE_MESSAGE);
    expect(thrown.message).toContain("infrastructure wait, not a test failure");
    // The waiter is not left behind once it gives up, and the holder is untouched.
    expect(second.environment.store.load().waiters).toEqual([]);
    expect(second.environment.store.load().lease.purpose).toBe("holder");
  });

  it("leaves an expired manual lease in place until a waiter takes it over", () => {
    const holder = harness({ devices: laneDevices() });
    const lease = commandAcquire({ purpose: "holder" }, holder.environment);
    holder.advance(MANUAL_LEASE_MS + 60_000);

    // Nothing tears the expired lease down on its own.
    const idle = commandStatus({ json: true }, holder.environment);
    expect(idle).toMatchObject({ live: false, reason: "expired", lease: { id: lease.id } });
    expect(holder.booted()).toEqual([LANE_DEVICES.manual]);

    const waiter = harness({ world: holder, pid: 90_002, env: { GITHUB_ACTIONS: "true" } });
    const taken = commandAcquire({ purpose: "lane-ios" }, waiter.environment);

    expect(taken.lane).toBe("ci");
    expect(taken.id).not.toBe(lease.id);
    expect(holder.booted()).toEqual([LANE_DEVICES.ci]);
    expect(waiter.output()).toContain("Took over the manual lease");
  });

  it("takes over a ci lease whose holder was killed, with no manual cleanup", () => {
    const ci = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices(), pid: 90_003 });
    commandAcquire({ purpose: "lane-ios build" }, ci.environment);
    ci.table.delete(90_003); // the holder is killed

    const worker = harness({ world: ci, pid: 90_004, env: { MOVIECAL_WORKER_SANDBOX: "1" } });
    const lease = commandAcquire({ purpose: "MOV-309" }, worker.environment);

    expect(lease.lane).toBe("worker");
    expect(worker.output()).toContain("holder-gone");
    expect(ci.booted()).toEqual([LANE_DEVICES.worker]);
  });

  it("waits for unmanaged simulator use, never shuts it down, and reports it", () => {
    const session = harness({ devices: laneDevices("Booted"), env: { GITHUB_ACTIONS: "true" } });

    expect(() => commandAcquire({ waitMs: 120_000 }, session.environment)).toThrow(LeaseUnavailableError);
    expect(session.booted()).toEqual([SHARED_DEVICE_NAME]);
    expect(session.warnings.join("\n")).toContain("unmanaged simulator use");
    expect(session.warnings.join("\n")).toContain("never shut down automatically");
    expect(session.notifications.join("\n")).toContain("ci lane is waiting");
  });

  it("treats a running xcodebuild with no live lease as unmanaged too", () => {
    const session = harness({ devices: laneDevices(), xcodebuild: [4321] });
    expect(() => commandAcquire({ waitMs: 0 }, session.environment)).toThrow(/running xcodebuild pid\(s\) 4321/u);
  });

  it("shuts an unmanaged device down only under the explicit human override", () => {
    const session = harness({ devices: laneDevices("Booted") });
    expect(commandAcquire({ forceShutdownUnmanaged: true }, session.environment).device.name).toBe(LANE_DEVICES.manual);
    expect(session.booted()).toEqual([LANE_DEVICES.manual]);
  });

  it("makes a re-acquire after the hard cap queue behind an existing waiter", () => {
    const holder = harness({ devices: laneDevices() });
    commandAcquire({ purpose: "holder" }, holder.environment);
    holder.advance(MANUAL_HARD_CAP_MS + 60_000);

    // A CI job is already queued when the capped holder tries to come back.
    const record = holder.environment.store.load();
    record.waiters.push({ id: "queued-ci", lane: "ci", pid: 90_005, startedAt: "start-90005", since: new Date(holder.at()).toISOString() });
    holder.environment.store.save(record);
    holder.table.set(90_005, "start-90005");

    expect(() => commandExtend({}, holder.environment)).toThrow(HardCapError);
    commandRelease({}, holder.environment);

    const again = harness({ world: holder, pid: 90_006 });
    expect(() => commandAcquire({ purpose: "back again", waitMs: 30_000 }, again.environment))
      .toThrow(/waiter\(s\) ahead of this one in the queue/u);
  });

  it("renews a lease id handed via MOVIECAL_IOS_SIM_LEASE_ID instead of queueing behind it (MOV-311)", () => {
    const dispatcher = harness({ env: { MOVIECAL_WORKER_SANDBOX: "1" }, devices: laneDevices(), pid: 90_007 });
    const held = commandAcquire({ purpose: "dispatcher worker run" }, dispatcher.environment);

    const worker = harness({
      world: dispatcher, pid: 90_008,
      env: { MOVIECAL_WORKER_SANDBOX: "1", MOVIECAL_IOS_SIM_LEASE_ID: held.id },
    });
    const observedSleep = [];
    worker.environment.sleep = (ms) => observedSleep.push(ms);

    const reentered = commandAcquire({ purpose: "nested ios:sim:run" }, worker.environment);

    expect(reentered.id).toBe(held.id);
    expect(observedSleep).toEqual([]); // acquired on the first attempt, no FIFO wait
    expect(worker.environment.store.load().waiters).toEqual([]);
  });

  it("does not treat an unrelated env value as a reentrant match", () => {
    const dispatcher = harness({ env: { MOVIECAL_WORKER_SANDBOX: "1" }, devices: laneDevices(), pid: 90_009 });
    commandAcquire({ purpose: "dispatcher worker run" }, dispatcher.environment);

    const other = harness({ world: dispatcher, pid: 90_010, env: { MOVIECAL_WORKER_SANDBOX: "1", MOVIECAL_IOS_SIM_LEASE_ID: "not-the-held-lease" } });
    expect(() => commandAcquire({ purpose: "unrelated", waitMs: 0 }, other.environment)).toThrow(LeaseUnavailableError);
  });
});

describe("ios:sim:run (MOV-311 reentrancy)", () => {
  const trivialCommand = [process.execPath, "-e", "process.exit(0)"];

  it("runs the wrapped command, releases its own originated lease, and shuts the device down", async () => {
    const session = harness({ devices: laneDevices() });
    const exitCode = await commandRun({ commandArgs: trivialCommand }, session.environment);

    expect(exitCode).toBe(0);
    expect(session.environment.store.load().lease).toBeNull();
    expect(session.booted()).toEqual([]);
  });

  it("never waits on a lease id it was handed, and does not release it on exit", async () => {
    const dispatcher = harness({ env: { MOVIECAL_WORKER_SANDBOX: "1" }, devices: laneDevices(), pid: 90_020 });
    const held = commandAcquire({ purpose: "dispatcher worker run" }, dispatcher.environment);

    const worker = harness({
      world: dispatcher, pid: 90_021,
      env: { MOVIECAL_WORKER_SANDBOX: "1", MOVIECAL_IOS_SIM_LEASE_ID: held.id },
    });
    worker.environment.sleep = () => {
      throw new Error("must never wait when reentering a handed-down lease id");
    };

    const exitCode = await commandRun({ commandArgs: trivialCommand }, worker.environment);

    expect(exitCode).toBe(0);
    // The dispatcher's own lease is still live -- the reentrant run did not tear it down.
    expect(dispatcher.environment.store.load().lease?.id).toBe(held.id);
    expect(dispatcher.booted()).toEqual([LANE_DEVICES.worker]);
  });
});

describe("ios:sim:release, extend, status, adopt, and the watcher", () => {
  it("releases the lease and shuts the device down, unless --keep-booted", () => {
    const session = harness({ devices: laneDevices() });
    commandAcquire({}, session.environment);

    commandRelease({ keepBooted: true }, session.environment);
    expect(session.booted()).toEqual([LANE_DEVICES.manual]);
    expect(session.environment.store.load().lease).toBeNull();

    commandAdopt({}, session.environment);
    commandRelease({}, session.environment);
    expect(session.booted()).toEqual([]);
    expect(session.environment.store.load().lease).toBeNull();
  });

  it("adopts an unmanaged boot as a manual lease, and only in the manual lane", () => {
    const session = harness({ devices: laneDevices("Booted") });
    expect(commandAdopt({}, session.environment)).toMatchObject({ lane: "manual", device: { name: SHARED_DEVICE_NAME } });
    expect(session.output()).toContain("ios:sim:release");
    expect(session.booted()).toEqual([SHARED_DEVICE_NAME]);

    const ci = harness({ devices: laneDevices("Booted"), env: { GITHUB_ACTIONS: "true" } });
    expect(() => commandAdopt({}, ci.environment)).toThrow(/only runs in the manual lane/u);
  });

  it("reports the holder, the waiters, and a memory line", () => {
    const session = harness({ devices: laneDevices() });
    commandAcquire({ purpose: "MOV-309 manual test", ref: "agent/MOV-309" }, session.environment);
    const record = session.environment.store.load();
    record.waiters.push({ id: "waiting-ci", lane: "ci", pid: process.pid, since: new Date(session.at() - 90_000).toISOString() });
    session.environment.store.save(record);

    expect(commandStatus({}, session.environment).live).toBe(true);
    expect(session.output()).toContain("MOV-309 manual test");
    expect(session.output()).toContain("Waiters (FIFO): ci pid");
    expect(session.output()).toContain("waiting 1m 30s");
    expect(session.output()).toContain("Memory: total = 3072.00M");
    expect(session.output()).toContain("System-wide memory free percentage: 42%");
  });

  it("extends a manual lease and refuses a lane it does not own", () => {
    const session = harness({ devices: laneDevices() });
    commandAcquire({}, session.environment);
    session.advance(10 * 60_000);

    expect(Date.parse(commandExtend({}, session.environment).expiresAt)).toBe(session.at() + MANUAL_LEASE_MS);

    const ci = harness({ world: session, env: { GITHUB_ACTIONS: "true" }, pid: 90_007 });
    expect(() => commandExtend({}, ci.environment)).toThrow(/belongs to the manual lane/u);
  });

  it("warns a manual holder at T-5 minutes, at expiry, and when someone starts waiting", async () => {
    const session = harness({ devices: laneDevices(), env: { MOVIECAL_IOS_SIM_WATCH_INTERVAL_MS: "60000" } });
    const lease = commandAcquire({ purpose: "holder" }, session.environment);
    const record = session.environment.store.load();
    record.waiters.push({ id: "waiting-ci", lane: "ci", pid: process.pid, since: new Date(session.at()).toISOString() });
    session.environment.store.save(record);

    expect(await commandWatch({ id: lease.id }, session.environment)).toBe(0);

    const announced = session.notifications.join("\n");
    expect(announced).toContain("Someone is waiting for the iOS simulator");
    expect(announced).toContain("iOS simulator lease expires in 5 minutes");
    expect(announced).toContain("iOS simulator lease expired");
    expect(announced).toContain("ios:sim:extend");
    // Exactly one T-5 warning per expiry time, not one per poll.
    expect(session.notifications.filter((entry) => entry.includes("expires in 5 minutes"))).toHaveLength(1);
    // The watcher only notifies; it never releases the lease or the device.
    expect(session.environment.store.load().lease.id).toBe(lease.id);
    expect(session.booted()).toEqual([LANE_DEVICES.manual]);
  });

  it("heartbeats a ci lease until its holder dies, then stops without cleaning up", async () => {
    const ci = harness({
      env: { GITHUB_ACTIONS: "true", MOVIECAL_IOS_SIM_WATCH_INTERVAL_MS: "30000" },
      devices: laneDevices(), pid: 90_008,
    });
    const lease = commandAcquire({ purpose: "lane-ios" }, ci.environment);

    let checks = 0;
    const alive = ci.environment.isProcessAlive;
    ci.environment.isProcessAlive = (holder) => (holder.pid === 90_008 && (checks += 1) > 3 ? false : alive(holder));

    expect(await commandWatch({ id: lease.id }, ci.environment)).toBe(0);

    const stored = ci.environment.store.load().lease;
    expect(Date.parse(stored.heartbeatAt)).toBeGreaterThan(Date.parse(lease.heartbeatAt));
    // A dead holder's lease is left in place for the next acquirer to take over.
    expect(stored.id).toBe(lease.id);
  });
});

describe("start-of-job cleanup (MOV-493)", () => {
  it("selects only booted moviecal-* lane devices that the lease does not own", () => {
    const booted = laneDevices("Booted", "Booted", "Booted", "Booted");
    const selected = selectStaleLaneDevices(booted, [`udid-${LANE_DEVICES.ci}`]);
    expect(selected.map((entry) => entry.name)).toEqual([LANE_DEVICES.worker, LANE_DEVICES.manual]);
    expect(selectStaleLaneDevices([device("Someone's iPad", "Booted")])).toEqual([]);
  });

  it("shuts a stale moviecal-manual down in a CI job and names it in the log", () => {
    const session = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices("Shutdown", "Shutdown", "Shutdown", "Booted") });
    commandAcquire({}, session.environment);

    expect(session.booted()).toEqual([LANE_DEVICES.ci]);
    expect(session.output()).toMatch(/Start-of-job cleanup: shutting down leftover simulator moviecal-manual/u);
  });

  it("still waits on a booted simulator it does not know about", () => {
    const session = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices("Booted") });
    expect(() => commandAcquire({ waitMs: 0 }, session.environment)).toThrow(LeaseUnavailableError);
    expect(session.booted()).toEqual([SHARED_DEVICE_NAME]);
  });

  it("does not auto-shut a stale lane device down outside the CI lane", () => {
    const session = harness({ devices: laneDevices("Shutdown", "Shutdown", "Booted") });
    expect(() => commandAcquire({ waitMs: 0 }, session.environment)).toThrow(LeaseUnavailableError);
    expect(session.booted()).toEqual([LANE_DEVICES.worker]);
  });
});

describe("early-progress watch (MOV-493)", () => {
  it("expires only after the limit with no suite start, using the injected clock", () => {
    const watch = createProgressWatch({ startedAtMs: 1000 });
    expect(watch.expired(1000 + EARLY_PROGRESS_LIMIT_MS - 1)).toBe(false);
    expect(watch.expired(1000 + EARLY_PROGRESS_LIMIT_MS)).toBe(true);
  });

  it("never expires once a suite start is seen, even split across chunks", () => {
    const watch = createProgressWatch({ startedAtMs: 0 });
    watch.onOutput("Build succeeded\nTest Suite 'All te");
    expect(watch.seen).toBe(false);
    watch.onOutput("sts' started at 2026-11-02 10:00:00.000\n");
    expect(watch.seen).toBe(true);
    expect(watch.expired(10 * EARLY_PROGRESS_LIMIT_MS)).toBe(false);
  });

  it("fails a silent run at the limit with exit 76, diagnostics, and a released lease", async () => {
    const session = harness({ env: { MOVIECAL_IOS_SIM_PROGRESS_POLL_MS: "20" }, devices: laneDevices() });
    const t0 = Date.now();
    session.environment.now = () => START + (Date.now() - t0) * 1000;
    const exitCode = await commandRun(
      { commandArgs: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], progressWithinMs: 1000 },
      session.environment,
    );

    expect(exitCode).toBe(EARLY_PROGRESS_EXIT_CODE);
    expect(session.warnings.join("\n")).toMatch(/SIMULATOR_TESTS_NOT_STARTED: no test suite started within 1s/u);
    expect(session.warnings.join("\n")).toMatch(/--- simctl list/u);
    expect(session.environment.store.load().lease).toBeNull();
    expect(session.booted()).toEqual([]);
  });

  it("does not fail a run that starts its suites in time", async () => {
    const session = harness({ env: { MOVIECAL_IOS_SIM_PROGRESS_POLL_MS: "20" }, devices: laneDevices() });
    const script = "console.log(\"Test Suite 'All tests' started at now\"); setTimeout(() => {}, 300)";
    const exitCode = await commandRun({ commandArgs: [process.execPath, "-e", script], progressWithinMs: 1 }, session.environment);

    expect(exitCode).toBe(0);
    expect(session.warnings.join("\n")).not.toMatch(/SIMULATOR_TESTS_NOT_STARTED/u);
  });

  it("parses --early-progress and --progress-within", () => {
    expect(parseArguments(["run", "--early-progress", "--", "x"])).toMatchObject({ earlyProgress: true, commandArgs: ["x"] });
    expect(parseArguments(["run", "--progress-within", "2", "--", "x"]).progressWithinMs).toBe(120_000);
  });
});

describe("bounded lease release (MOV-493)", () => {
  it("passes the bounded timeout to the shutdown and logs how long it took", () => {
    const session = harness({ devices: laneDevices() });
    commandAcquire({}, session.environment);
    const timeouts = [];
    const inner = session.environment.run;
    session.environment.run = (command, args, options) => {
      if (args?.[1] === "shutdown") timeouts.push(options?.timeout);
      return inner(command, args, options);
    };
    commandRelease({}, session.environment);

    expect(timeouts).toEqual([RELEASE_SHUTDOWN_TIMEOUT_MS]);
    expect(session.output()).toMatch(/shut moviecal-manual down in \d+s/u);
  });

  it("warns instead of hanging or throwing when the shutdown gives up", () => {
    const session = harness({ devices: laneDevices() });
    commandAcquire({}, session.environment);
    const inner = session.environment.run;
    session.environment.run = (command, args, options) =>
      args?.[1] === "shutdown" ? { status: 1, stdout: "", stderr: "timed out" } : inner(command, args, options);

    expect(() => commandRelease({}, session.environment)).not.toThrow();
    expect(session.environment.store.load().lease).toBeNull();
    expect(session.warnings.join("\n")).toMatch(/did not finish within 1m 00s/u);
  });
});

describe("shutdown verification (MOV-497)", () => {
  function clock() {
    let at = 0;
    return { now: () => at, sleep: (ms) => { at += ms; } };
  }

  it("polls the state with a fake clock: first read, after N reads, never", () => {
    const first = clock();
    expect(pollUntilShutdown({ read: () => "Shutdown", ...first })).toMatchObject({ shutdown: true, reads: 1, elapsedMs: 0 });

    const later = clock();
    let reads = 0;
    expect(pollUntilShutdown({ read: () => (++reads >= 4 ? "Shutdown" : "Booted"), ...later })).toMatchObject({
      shutdown: true, reads: 4, elapsedMs: 3000,
    });

    const never = clock();
    const result = pollUntilShutdown({ read: () => "Booted", ...never });
    expect(result).toMatchObject({ shutdown: false, state: "Booted", elapsedMs: SHUTDOWN_VERIFY_TIMEOUT_MS });
    expect(pollUntilShutdown({ read: () => null, ...clock() }).shutdown).toBe(false);
  });

  it("computes the CPU split and explains a non-live lease", () => {
    const sample = [{ times: { user: 60, nice: 0, sys: 30, idle: 10, irq: 0 } }];
    expect(cpuSplit(sample)).toEqual({ user: 60, system: 30, idle: 10 });
    expect(cpuSplit(sample, sample)).toBeNull();
    expect(describeNotLive({ lane: "ci", holder: { pid: 42 } }, "holder-gone")).toMatch(/pid 42\) has exited.*ios:sim:run/u);
    expect(describeNotLive({ lane: "manual" }, "expired")).toBe("not live — expired");
  });

  it("reports status of a lease whose acquiring process exited without a bare 'expired'", () => {
    const ci = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices(), pid: 91_001 });
    commandAcquire({}, ci.environment);
    ci.table.delete(91_001);
    commandStatus({}, ci.environment);
    expect(ci.output()).toMatch(/not live — holder-gone: the process that acquired it \(pid 91001\) has exited/u);
  });

  it("start-of-job cleanup fails fast when a stale device stays Booted, and releases the lease", () => {
    const session = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices("Shutdown", "Shutdown", "Shutdown", "Booted") });
    session.state.wedged = true;
    let error;
    try {
      commandAcquire({}, session.environment);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ServiceUnresponsiveError);
    expect(error.exitCode).toBe(SERVICE_UNRESPONSIVE_EXIT_CODE);
    expect(error.message).toMatch(/^SIMULATOR_SERVICE_UNRESPONSIVE: .*moviecal-manual/u);
    expect(session.warnings.join("\n")).toMatch(/SIMULATOR_STILL_BOOTED_AFTER_SHUTDOWN: moviecal-manual .* after 2 shutdown attempts/u);
    expect(session.warnings.join("\n")).toMatch(/load average 570\.10/u);
    expect(session.environment.store.load().lease).toBeNull();
    expect(session.booted()).toEqual([LANE_DEVICES.manual]);
  });

  it("fails fast when the job's own moviecal-ci is Booted and will not shut down, without bootstatus", () => {
    const session = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices("Shutdown", "Booted") });
    session.state.wedged = true;
    const subcommands = [];
    const inner = session.environment.run;
    session.environment.run = (command, args, options) => {
      subcommands.push(args?.[1]);
      return inner(command, args, options);
    };

    expect(() => commandAcquire({}, session.environment)).toThrow(/SIMULATOR_SERVICE_UNRESPONSIVE/u);
    expect(subcommands).not.toContain("bootstatus");
    expect(subcommands.filter((name) => name === "shutdown")).toHaveLength(2);
    expect(session.environment.store.load().lease).toBeNull();
  });

  it("maps the failure to exit code 77 through the CLI", async () => {
    const session = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices("Shutdown", "Booted") });
    session.state.wedged = true;
    expect(await runCli(["acquire"], session.environment)).toBe(SERVICE_UNRESPONSIVE_EXIT_CODE);
  });

  it("accepts a shutdown that takes effect after a delay, with no warning", () => {
    const session = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices("Shutdown", "Shutdown", "Shutdown", "Booted") });
    session.state.wedged = 3;
    commandAcquire({}, session.environment);

    expect(session.warnings).toEqual([]);
    expect(session.booted()).toEqual([LANE_DEVICES.ci]);
  });

  it("a normal shutdown costs one shutdown and one state read, no delay", () => {
    const session = harness({ env: { GITHUB_ACTIONS: "true" }, devices: laneDevices("Shutdown", "Shutdown", "Shutdown", "Booted") });
    const calls = [];
    const inner = session.environment.run;
    session.environment.run = (command, args, options) => {
      calls.push(args?.slice(1, 3).join(" "));
      return inner(command, args, options);
    };
    const before = session.at();
    commandAcquire({}, session.environment);

    expect(calls.filter((call) => call.startsWith("shutdown"))).toHaveLength(1);
    expect(calls.filter((call) => call === "list devices")).toHaveLength(2); // acquire's inventory + one state read
    expect(session.at()).toBe(before);
  });

  it("release never claims success while the device is still Booted, and still clears the lease", () => {
    const session = harness({ devices: laneDevices() });
    commandAcquire({}, session.environment);
    session.state.wedged = true;
    commandRelease({}, session.environment);

    expect(session.output()).not.toMatch(/shut .* down in/u);
    expect(session.warnings.join("\n")).toMatch(/SIMULATOR_STILL_BOOTED_AFTER_SHUTDOWN: moviecal-manual .* after 2 shutdown attempts/u);
    expect(session.warnings.join("\n")).toMatch(/still Booted after 2 shutdown attempts/u);
    expect(session.environment.store.load().lease).toBeNull();
  });

  it("release still logs success when a wedge clears after a delay", () => {
    const session = harness({ devices: laneDevices() });
    commandAcquire({}, session.environment);
    session.state.wedged = 4;
    commandRelease({}, session.environment);

    expect(session.output()).toMatch(/shut moviecal-manual down in/u);
    expect(session.warnings).toEqual([]);
  });

  it("a job's own booted device that goes silent is failed, diagnosed, and reported as not shut down on release", async () => {
    const session = harness({ env: { GITHUB_ACTIONS: "true", MOVIECAL_IOS_SIM_PROGRESS_POLL_MS: "20" }, devices: laneDevices() });
    session.state.wedged = true;
    const t0 = Date.now();
    session.environment.now = () => START + (Date.now() - t0) * 1000;
    const exitCode = await commandRun(
      { commandArgs: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], progressWithinMs: 1000 },
      session.environment,
    );

    expect(exitCode).toBe(EARLY_PROGRESS_EXIT_CODE);
    const warnings = session.warnings.join("\n");
    expect(warnings).toMatch(/--- system load ---\nload average 570\.10/u);
    expect(warnings).toMatch(/SIMULATOR_STILL_BOOTED_AFTER_SHUTDOWN: moviecal-ci/u);
    expect(session.output()).not.toMatch(/shut moviecal-ci down in/u);
    expect(session.environment.store.load().lease).toBeNull();
  });

  it("diagnostics run in parallel, stay under the total cap, and survive a hung command", async () => {
    const session = harness({ devices: laneDevices() });
    session.environment.diagnosticsCapMs = 50;
    session.environment.stuckDevices = new Set(["udid-moviecal-ci"]);
    let sampled = 0;
    session.environment.cpus = () => [{ times: { user: 700 * ++sampled, nice: 0, sys: 200 * sampled, idle: 100 * sampled, irq: 0 } }];
    session.environment.runAsync = (command, args) =>
      args?.[0] === "show" ? new Promise(() => {}) : Promise.resolve({ status: 0, stdout: `ok ${command}`, stderr: "" });

    const startedAt = Date.now();
    await captureSimulatorDiagnostics(session.environment, { device: { name: "moviecal-ci", udid: "udid-moviecal-ci" } });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    const warnings = session.warnings.join("\n");
    expect(warnings).toMatch(/--- simctl list \(exit 0\) ---\nok xcrun/u);
    expect(warnings).toMatch(/recent CoreSimulator log lines: still running at the 0s diagnostics cap; abandoned/u);
    expect(warnings).toMatch(/CPU 70% user, 20% system, 10% idle/u);
    expect(warnings).toMatch(/CoreSimulatorService is the likely culprit/u);
  });
});
