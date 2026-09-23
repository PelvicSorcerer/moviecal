// Integration seam for the machine-wide simulator lease (MOV-309): real
// concurrent child processes racing for the same state directory, a real killed
// holder, and real SIGINT/SIGTERM handling — all against a scriptable `simctl`
// stub, never a real simulator.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ios-sim-lease.mjs");
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-26-0";
const DEVICES = ["iPhone 17", "moviecal-ci", "moviecal-worker", "moviecal-manual"];

const XCRUN_STUB = `#!/usr/bin/env node
const fs = require("fs");
const file = process.env.MOVIECAL_FAKE_SIM_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const [, subcommand, ...rest] = process.argv.slice(2);
if (subcommand === "list" && rest[0] === "devices") {
  const grouped = {};
  for (const device of state.devices) {
    grouped[device.runtime] = grouped[device.runtime] || [];
    grouped[device.runtime].push({ ...device, isAvailable: true });
  }
  process.stdout.write(JSON.stringify({ devices: grouped }));
} else if (subcommand === "list" && rest[0] === "runtimes") {
  process.stdout.write(JSON.stringify({ runtimes: state.runtimes }));
} else if (subcommand === "bootstatus" || subcommand === "shutdown") {
  const device = state.devices.find((entry) => entry.udid === rest[0]);
  if (!device) { process.stderr.write("Invalid device"); process.exit(1); }
  if (subcommand === "shutdown" && device.state !== "Booted") {
    process.stderr.write("Unable to shutdown device in current state: Shutdown");
    process.exit(1);
  }
  device.state = subcommand === "bootstatus" ? "Booted" : "Shutdown";
  const temporary = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, file);
} else {
  process.stderr.write("unexpected simctl " + subcommand);
  process.exit(1);
}
`;

const temporaryDirectories = [];
const children = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "moviecal-ios-sim-lease-it-"));
  temporaryDirectories.push(directory);

  const simulatorState = path.join(directory, "simulators.json");
  writeFileSync(simulatorState, JSON.stringify({
    devices: DEVICES.map((name) => ({ name, udid: `udid-${name}`, state: "Shutdown", runtime: RUNTIME })),
    runtimes: [{ identifier: RUNTIME, version: "26.0", isAvailable: true }],
  }));

  const stub = (name, source) => {
    const file = path.join(directory, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
    return file;
  };

  const environment = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MOVIECAL_IOS_SIM_STATE_DIR: directory,
    MOVIECAL_IOS_SIM_XCRUN: stub("xcrun-stub.js", XCRUN_STUB),
    MOVIECAL_IOS_SIM_PGREP: stub("pgrep-stub.js", "#!/usr/bin/env node\nprocess.exit(1);\n"),
    MOVIECAL_FAKE_SIM_STATE: simulatorState,
    MOVIECAL_IOS_SIM_WATCHER: "0",
    MOVIECAL_IOS_SIM_POLL_MS: "100",
    ...extra,
  });

  const read = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };

  return {
    directory,
    environment,
    lease: () => read(path.join(directory, "ios-sim-lease.json")),
    booted: () => read(simulatorState).devices.filter((device) => device.state === "Booted").map((device) => device.name),
  };
}

function start(args, environment, { detached = false } = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: environment, stdio: ["ignore", "pipe", "pipe"], detached });
  children.push(child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.result = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  return child;
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("concurrent acquires (MOV-309)", () => {
  it("never lets two real processes hold the lease at once", async () => {
    const world = fixture();
    const racers = [0, 1, 2, 3].map((index) => start(["acquire", "--wait", "0", "--purpose", `racer-${index}`], world.environment()));

    const results = await Promise.all(racers.map((child) => child.result));
    const winners = results.filter((result) => result.code === 0);

    expect(winners).toHaveLength(1);
    expect(winners[0].stdout).toContain("npm run ios:sim:release");
    for (const loser of results.filter((result) => result.code !== 0)) {
      expect(loser.code).toBe(75);
      expect(loser.stderr).toContain("SIMULATOR_LEASE_UNAVAILABLE");
    }

    const record = world.lease();
    expect(record.lease).toMatchObject({ lane: "manual", device: { name: "moviecal-manual" } });
    expect(record.waiters).toEqual([]);
    expect(world.booted()).toEqual(["moviecal-manual"]);
  }, 60_000);
});

describe("stale holder takeover (MOV-309)", () => {
  it("takes a killed worker holder's lease over and shuts its device down", async () => {
    const world = fixture();
    const holder = start(
      ["run", "--", process.execPath, "-e", "setInterval(() => {}, 1000)"],
      world.environment({ MOVIECAL_WORKER_SANDBOX: "1" }),
      { detached: true },
    );
    await waitFor(() => world.lease()?.lease?.lane === "worker", "the worker lease to be held");
    await waitFor(() => world.booted().length === 1, "the worker device to boot");
    expect(world.booted()).toEqual(["moviecal-worker"]);

    process.kill(-holder.pid, "SIGKILL");
    await holder.result;

    const takeover = await start(["acquire", "--wait", "1"], world.environment({ GITHUB_ACTIONS: "true" })).result;

    expect(takeover.code).toBe(0);
    expect(takeover.stdout).toContain("Took over the worker lease");
    expect(takeover.stdout).toContain("holder-gone");
    expect(world.lease().lease).toMatchObject({ lane: "ci", device: { name: "moviecal-ci" } });
    expect(world.booted()).toEqual(["moviecal-ci"]);
  }, 60_000);
});

describe("ios:sim:run lease lifetime (MOV-309)", () => {
  it.each(["SIGINT", "SIGTERM"])("releases the lease when the run is interrupted by %s", async (signal) => {
    const world = fixture();
    const ready = path.join(world.directory, `ready-${signal}`);
    const run = start(
      ["run", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ready)}, "1"); setInterval(() => {}, 1000)`],
      world.environment(),
    );
    await waitFor(() => existsSync(ready), "the leased command to start");

    run.kill(signal);
    const result = await run.result;

    expect(result.code).toBeGreaterThan(0);
    expect(world.lease().lease).toBeNull();
    expect(world.booted()).toEqual([]);
  }, 60_000);

  it("releases the lease on success and on a failing command, propagating its exit code", async () => {
    const world = fixture();

    const passed = await start(["run", "--", process.execPath, "-e", ""], world.environment()).result;
    expect(passed.code).toBe(0);
    expect(world.lease().lease).toBeNull();
    expect(world.booted()).toEqual([]);

    const failed = await start(["run", "--", process.execPath, "-e", "process.exit(3)"], world.environment()).result;
    expect(failed.code).toBe(3);
    expect(world.lease().lease).toBeNull();
    expect(world.booted()).toEqual([]);
  }, 60_000);
});
