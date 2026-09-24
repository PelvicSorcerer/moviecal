import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTemporaryXcconfig,
  parseArguments,
  readManualTestConfiguration,
  runManualTestBuild,
} from "../scripts/ios-manual-test.mjs";

const temporaryDirectories = [];

function createEnvFile(contents) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "moviecal-ios-manual-test-"));
  const file = path.join(directory, "ios-manual-test.env");

  temporaryDirectories.push(directory);
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fakeLease(overrides = {}) {
  return {
    id: "lease-1",
    lane: "manual",
    device: { name: "moviecal-manual", udid: "manual-udid" },
    expiresAt: "2026-09-23T10:20:00.000Z",
    hardCapAt: "2026-09-23T11:00:00.000Z",
    ...overrides,
  };
}

describe("ios manual-test command", () => {
  it("defaults to the manual-lane device when --device is omitted", () => {
    expect(parseArguments([]).device).toBe("booted");
  });

  it("rejects an empty --device value", () => {
    expect(() => parseArguments(["--device", ""])).toThrow(/--device/i);
  });

  it("reads only the two build configuration values", () => {
    const config = readManualTestConfiguration(
      createEnvFile(
        [
          "MOVIECAL_SUPABASE_URL=https://manual-test.supabase.co",
          "MOVIECAL_SUPABASE_ANON_KEY=sb_publishable_test_value",
          "MOVIECAL_TEST_EMAIL=tester@example.com",
          "MOVIECAL_TEST_PASSWORD=not-for-builds",
          "",
        ].join("\n"),
      ),
    );

    expect(config).toEqual({
      url: "https://manual-test.supabase.co/",
      anonKey: "sb_publishable_test_value",
    });
  });

  it.each([
    "MOVIECAL_SUPABASE_URL=https://manual-test.supabase.co\\n",
    [
      "MOVIECAL_SUPABASE_ANON_KEY=your-supabase-anon-key",
      "MOVIECAL_SUPABASE_URL=https://manual-test.supabase.co",
      "",
    ].join("\n"),
  ])("rejects invalid configuration before invoking a build command", (contents) => {
    const command = vi.fn();

    expect(() =>
      runManualTestBuild(
        {
          device: "booted",
          dryRun: false,
          envFile: createEnvFile(contents),
        },
        { command },
      ),
    ).toThrow(/manual-test configuration/i);
    expect(command).not.toHaveBeenCalled();
  });

  it("writes a private temporary xcconfig and removes it on disposal", () => {
    const temporaryConfig = createTemporaryXcconfig({
      url: "https://manual-test.supabase.co/api/v1",
      anonKey: "sb_publishable_test_value",
    });

    try {
      expect(readFileSync(temporaryConfig.file, "utf8")).toContain(
        "MOVIECAL_SUPABASE_URL_SCHEME = https",
      );
      expect(readFileSync(temporaryConfig.file, "utf8")).toContain(
        "MOVIECAL_SUPABASE_URL_AUTHORITY_AND_PATH = manual-test.supabase.co/api/v1",
      );
      expect(readFileSync(temporaryConfig.file, "utf8")).not.toContain('"');
      expect(temporaryConfig.file).toContain("moviecal-ios-manual-");
    } finally {
      temporaryConfig.dispose();
    }

    expect(() => readFileSync(temporaryConfig.file, "utf8")).toThrow();
  });

  it("validates configuration without running commands or acquiring a lease in dry-run mode", () => {
    const command = vi.fn();
    const log = vi.fn();
    const acquireLease = vi.fn();
    const key = "sb_publishable_test_value";

    runManualTestBuild(
      {
        device: "booted",
        dryRun: true,
        envFile: createEnvFile(
          [
            "MOVIECAL_SUPABASE_URL=https://manual-test.supabase.co",
            "MOVIECAL_SUPABASE_ANON_KEY=" + key,
            "",
          ].join("\n"),
        ),
      },
      {
        command,
        getSourceIdentity: () => ({ branch: "test", sha: "abcdef0" }),
        log,
        acquireLease,
      },
    );

    expect(command).not.toHaveBeenCalled();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/configuration validated/i),
    );
    expect(log.mock.calls.flat().join("\\n")).not.toContain(key);
  });

  describe("lease and device resolution (MOV-311)", () => {
    function configFile() {
      return createEnvFile(
        [
          "MOVIECAL_SUPABASE_URL=https://manual-test.supabase.co",
          "MOVIECAL_SUPABASE_ANON_KEY=sb_publishable_test_value",
          "",
        ].join("\n"),
      );
    }

    function fakeCommand(bootedDevices = []) {
      return vi.fn((command, args) => {
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") {
          const devices = {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
              { name: "moviecal-ci", udid: "ci-udid", state: "Shutdown" },
              { name: "moviecal-worker", udid: "worker-udid", state: "Shutdown" },
              { name: "moviecal-manual", udid: "manual-udid", state: "Shutdown" },
              ...bootedDevices,
            ],
          };
          return JSON.stringify({ devices });
        }
        if (command === "plutil") {
          return args.includes("MoviecalSupabaseURL") ? "https://manual-test.supabase.co/" : "sb_publishable_test_value";
        }
        return "";
      });
    }

    it("acquires a manual-lane lease before the clean build and uses its device by default", () => {
      const command = fakeCommand();
      const log = vi.fn();
      const acquireLease = vi.fn(() => fakeLease());

      runManualTestBuild(
        { device: "booted", dryRun: false, envFile: configFile() },
        { command, getSourceIdentity: () => ({ branch: "feature", sha: "abc1234" }), log, acquireLease },
      );

      expect(acquireLease).toHaveBeenCalledTimes(1);
      const buildDestination = command.mock.calls.find(([cmd]) => cmd === "xcodebuild")[1];
      expect(buildDestination).toContain("platform=iOS Simulator,id=manual-udid");
      expect(command).toHaveBeenCalledWith("xcrun", ["simctl", "install", "manual-udid", expect.any(String)], expect.anything());
    });

    it("prints the agent-guidance block on success", () => {
      const command = fakeCommand();
      const log = vi.fn();
      const acquireLease = vi.fn(() => fakeLease());

      runManualTestBuild(
        { device: "booted", dryRun: false, envFile: configFile() },
        { command, getSourceIdentity: () => ({ branch: "feature", sha: "abc1234" }), log, acquireLease },
      );

      const printed = log.mock.calls.flat().join("\n");
      expect(printed).toMatch(/lease id lease-1/);
      expect(printed).toMatch(/npm run ios:sim:release/);
    });

    it("refuses an explicit --device naming the CI or worker lane device without acquiring a lease", () => {
      const command = fakeCommand();
      const acquireLease = vi.fn();

      expect(() =>
        runManualTestBuild(
          { device: "moviecal-worker", dryRun: false, envFile: configFile() },
          { command, getSourceIdentity: () => ({ branch: "feature", sha: "abc1234" }), log: vi.fn(), acquireLease },
        ),
      ).toThrow(/reserved for its own lane/i);
      expect(acquireLease).not.toHaveBeenCalled();
    });

    it("still acquires a manual lease when an explicit non-reserved device is given, but builds on that device", () => {
      const command = fakeCommand([{ name: "iPhone 17", udid: "shared-udid", state: "Shutdown" }]);
      const acquireLease = vi.fn(() => fakeLease());

      runManualTestBuild(
        { device: "shared-udid", dryRun: false, envFile: configFile() },
        { command, getSourceIdentity: () => ({ branch: "feature", sha: "abc1234" }), log: vi.fn(), acquireLease },
      );

      expect(acquireLease).toHaveBeenCalledTimes(1);
      const buildDestination = command.mock.calls.find(([cmd]) => cmd === "xcodebuild")[1];
      expect(buildDestination).toContain("platform=iOS Simulator,id=shared-udid");
    });
  });
});
