import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvFile, checkSecretFileMode } from "../src/config.mjs";

describe("parseEnvFile", () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
  });

  it("returns {} when the file is missing", () => {
    expect(parseEnvFile("/nonexistent/path/does/not/exist.env")).toEqual({});
  });

  it("parses KEY=VALUE lines, skips comments and blanks, strips quotes", () => {
    tmpFile = path.join(os.tmpdir(), `moviecal-test-${Date.now()}.env`);
    fs.writeFileSync(
      tmpFile,
      [
        "# a comment",
        "",
        'LINEAR_API_KEY="lin_api_abc123"',
        "LINEAR_TEAM_KEY=MOV",
        "UNQUOTED=plain-value",
      ].join("\n"),
    );

    expect(parseEnvFile(tmpFile)).toEqual({
      LINEAR_API_KEY: "lin_api_abc123",
      LINEAR_TEAM_KEY: "MOV",
      UNQUOTED: "plain-value",
    });
  });
});

describe("checkSecretFileMode", () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
  });

  it("fails when the file is missing", () => {
    const result = checkSecretFileMode("/nonexistent/path.env");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/);
  });

  it("fails when the file is group/other readable", () => {
    tmpFile = path.join(os.tmpdir(), `moviecal-test-mode-${Date.now()}.env`);
    fs.writeFileSync(tmpFile, "FOO=bar\n", { mode: 0o644 });
    const result = checkSecretFileMode(tmpFile);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/600/);
  });

  it("passes when the file is mode 600", () => {
    tmpFile = path.join(os.tmpdir(), `moviecal-test-mode-ok-${Date.now()}.env`);
    fs.writeFileSync(tmpFile, "FOO=bar\n", { mode: 0o600 });
    const result = checkSecretFileMode(tmpFile);
    expect(result.ok).toBe(true);
  });
});
