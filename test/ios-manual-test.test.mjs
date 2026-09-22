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

describe("ios manual-test command", () => {
  it("requires an explicit simulator device", () => {
    expect(() => parseArguments([])).toThrow(/simulator device/i);
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

  it("validates configuration without running commands in dry-run mode", () => {
    const command = vi.fn();
    const log = vi.fn();
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
      },
    );

    expect(command).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/configuration validated/i),
    );
    expect(log.mock.calls.flat().join("\\n")).not.toContain(key);
  });
});
