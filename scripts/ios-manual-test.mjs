#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandAcquire, createEnvironment as createLeaseEnvironment } from "./ios-sim-lease.mjs";
import { LANE_DEVICES, agentGuidance } from "./lib/ios-sim-lease-core.mjs";

const DEFAULT_ENV_FILE = path.join(
  os.homedir(),
  ".config",
  "moviecal",
  "ios-manual-test.env",
);
const PLACEHOLDER_VALUES = new Set([
  "your-supabase-anon-key",
  "https://your-project-ref.supabase.co",
]);
const BUNDLE_IDENTIFIER = "com.moviecal.ios";

export function parseArguments(argv) {
  const options = {
    device: "booted",
    dryRun: false,
    envFile: DEFAULT_ENV_FILE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--device") {
      options.device = argv[++index] ?? null;
      continue;
    }

    if (argument === "--env-file") {
      options.envFile = argv[++index] ?? null;
      continue;
    }

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.device) {
    throw new Error("--device requires a value: booted or a UDID.");
  }

  if (!options.envFile) {
    throw new Error("--env-file requires a path.");
  }

  return options;
}

function parseEnvironmentValue(value) {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));

  return quoted ? trimmed.slice(1, -1) : trimmed;
}

export function readManualTestConfiguration(envFile) {
  let contents;

  try {
    contents = readFileSync(envFile, "utf8");
  } catch {
    throw new Error("The iOS manual-test configuration is unavailable.");
  }

  const values = new Map();

  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(
      /^\s*(MOVIECAL_SUPABASE_(?:URL|ANON_KEY))\s*=\s*(.*?)\s*$/u,
    );

    if (match) {
      values.set(match[1], parseEnvironmentValue(match[2]));
    }
  }

  const url = values.get("MOVIECAL_SUPABASE_URL");
  const anonKey = values.get("MOVIECAL_SUPABASE_ANON_KEY");

  if (
    !url ||
    !anonKey ||
    PLACEHOLDER_VALUES.has(url) ||
    PLACEHOLDER_VALUES.has(anonKey)
  ) {
    throw new Error("The iOS manual-test configuration is incomplete or placeholder-only.");
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("The iOS manual-test configuration is incomplete or placeholder-only.");
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("The iOS manual-test configuration is incomplete or placeholder-only.");
  }

  return { url: parsedUrl.toString(), anonKey };
}

function xcconfigValue(value) {
  if (/[\s"'\\$#;]|\/\//u.test(value)) {
    throw new Error("The iOS manual-test configuration is incomplete or placeholder-only.");
  }

  return value;
}

export function createTemporaryXcconfig(config) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "moviecal-ios-manual-"));
  const file = path.join(directory, "manual-test.xcconfig");
  const url = new URL(config.url);

  chmodSync(directory, 0o700);
  writeFileSync(
    file,
    [
      `MOVIECAL_SUPABASE_URL_SCHEME = ${xcconfigValue(url.protocol.slice(0, -1))}`,
      `MOVIECAL_SUPABASE_URL_AUTHORITY_AND_PATH = ${xcconfigValue(`${url.host}${url.pathname}${url.search}${url.hash}`)}`,
      `MOVIECAL_SUPABASE_ANON_KEY = ${xcconfigValue(config.anonKey)}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(file, 0o600);

  return {
    file,
    dispose() {
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

function runCommand(command, args, { cwd, capture = false, environment, timeout }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    stdio: capture ? "pipe" : "inherit",
    timeout,
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`The iOS manual-test command timed out (${command}).`);
  }

  if (result.error || result.status !== 0) {
    throw new Error(`The iOS manual-test build could not complete (${command}).`);
  }

  return result.stdout ?? "";
}

function sourceIdentity(cwd) {
  const dirtyPaths = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  }).trim();

  if (dirtyPaths) {
    throw new Error("The iOS manual-test checkout must be clean to report an exact source SHA.");
  }

  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();

  return { branch, sha };
}

/**
 * `--device booted` means the manual-lane device (MOV-311), never "whatever
 * happens to be booted" — the lease, not simctl state, decides the target.
 * An explicit UDID or name is resolved and rejected if it names the CI or
 * worker lane's own device; those are never valid manual-test targets.
 */
function resolveExplicitDevice(device, command, cwd) {
  const output = command(
    "xcrun",
    ["simctl", "list", "devices", "-j"],
    { cwd, capture: true, timeout: 30_000 },
  );
  const devices = Object.values(JSON.parse(output).devices).flat();
  const match = devices.find((candidate) => candidate.udid === device || candidate.name === device);
  const name = match?.name ?? device;

  if (name === LANE_DEVICES.ci || name === LANE_DEVICES.worker) {
    throw new Error(
      `--device ${device} names the ${name} simulator, which is reserved for its own lane. ` +
        `Use --device booted for the ${LANE_DEVICES.manual} device, or pass a different simulator.`,
    );
  }

  return match ? match.udid : device;
}

function defaultAcquireLease(purpose, ref) {
  // Internal chatter (mutex waits, takeover notices) is silenced here; the
  // caller prints the one thing that matters -- the agent-guidance block --
  // through its own injected `log`.
  const environment = createLeaseEnvironment({ log: () => {}, warn: () => {} });
  return commandAcquire({ purpose, ref }, environment);
}

function assertBuiltConfiguration(appPath, config, command, cwd) {
  const url = command(
    "plutil",
    ["-extract", "MoviecalSupabaseURL", "raw", "-o", "-", path.join(appPath, "Info.plist")],
    { cwd, capture: true },
  ).trim();
  const anonKey = command(
    "plutil",
    ["-extract", "MoviecalSupabaseAnonKey", "raw", "-o", "-", path.join(appPath, "Info.plist")],
    { cwd, capture: true },
  ).trim();

  if (url !== config.url || anonKey !== config.anonKey) {
    throw new Error("The built app does not contain the validated manual-test configuration.");
  }
}

export function runManualTestBuild(
  options,
  {
    cwd = process.cwd(),
    command = runCommand,
    getSourceIdentity = sourceIdentity,
    log = console.log,
    acquireLease = defaultAcquireLease,
  } = {},
) {
  const config = readManualTestConfiguration(options.envFile);
  const source = getSourceIdentity(cwd);

  if (options.dryRun) {
    log(`iOS manual-test configuration validated for ${source.branch}@${source.sha}.`);
    return;
  }

  const ref = `${source.branch}@${source.sha}`;
  const explicitDevice = options.device === "booted" ? null : resolveExplicitDevice(options.device, command, cwd);

  // MOV-311: acquired before the clean build and held after install/launch —
  // this is a manual-lane, time-based lease (MOV-309), so it outlives this
  // one-shot process on purpose. Release it with `npm run ios:sim:release`
  // once the user says they are finished testing.
  const lease = acquireLease(`ios:manual-test (${ref})`, ref);
  const device = explicitDevice ?? lease.device.udid;
  const derivedDataPath = path.join(os.tmpdir(), `moviecal-ios-manual-${source.sha}`);
  const appPath = path.join(
    derivedDataPath,
    "Build",
    "Products",
    "Debug-iphonesimulator",
    "Moviecal.app",
  );
  const temporaryConfig = createTemporaryXcconfig(config);

  try {
    command("xcrun", ["simctl", "bootstatus", device, "-b"], { cwd });
    command(
      "xcodebuild",
      [
        "-quiet",
        "-project",
        "ios/Moviecal.xcodeproj",
        "-scheme",
        "Moviecal",
        "-destination",
        `platform=iOS Simulator,id=${device}`,
        "-derivedDataPath",
        derivedDataPath,
        "-xcconfig",
        temporaryConfig.file,
        "clean",
        "build",
      ],
      { cwd },
    );
    assertBuiltConfiguration(appPath, config, command, cwd);
    command("xcrun", ["simctl", "install", device, appPath], { cwd });
    command("xcrun", ["simctl", "launch", device, BUNDLE_IDENTIFIER], { cwd });
  } finally {
    temporaryConfig.dispose();
  }

  log(agentGuidance(lease));
  log(`Installed ${BUNDLE_IDENTIFIER} from ${ref} on simulator ${device}.`);
}

function main() {
  try {
    runManualTestBuild(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
