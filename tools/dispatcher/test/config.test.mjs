import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvFile, checkSecretFileMode, loadLinearAppConfig, resolveLinearAuth } from "../src/config.mjs";

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

describe("loadLinearAppConfig", () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.rmSync(tmpFile);
    delete process.env.LINEAR_APP_CLIENT_ID;
  });

  it("returns all-null when the file is missing and no env vars are set", () => {
    expect(loadLinearAppConfig("/nonexistent/linear-app.env")).toEqual({
      clientId: null,
      clientSecret: null,
      actorId: null,
      scopes: null,
    });
  });

  it("reads the four keys from the file", () => {
    tmpFile = path.join(os.tmpdir(), `moviecal-test-app-${Date.now()}.env`);
    fs.writeFileSync(
      tmpFile,
      [
        "LINEAR_APP_CLIENT_ID=cid-123",
        "LINEAR_APP_CLIENT_SECRET=secret-456",
        "LINEAR_APP_ACTOR_ID=actor-789",
        "LINEAR_APP_SCOPES=read,write,app:assignable,app:mentionable",
      ].join("\n"),
      { mode: 0o600 },
    );
    expect(loadLinearAppConfig(tmpFile)).toEqual({
      clientId: "cid-123",
      clientSecret: "secret-456",
      actorId: "actor-789",
      scopes: "read,write,app:assignable,app:mentionable",
    });
  });

  it("falls back to process.env when the file lacks a key", () => {
    tmpFile = path.join(os.tmpdir(), `moviecal-test-app-partial-${Date.now()}.env`);
    fs.writeFileSync(tmpFile, "LINEAR_APP_CLIENT_SECRET=from-file\n", { mode: 0o600 });
    process.env.LINEAR_APP_CLIENT_ID = "from-env";
    const cfg = loadLinearAppConfig(tmpFile);
    expect(cfg.clientId).toBe("from-env");
    expect(cfg.clientSecret).toBe("from-file");
    expect(cfg.scopes).toBeNull();
  });
});

describe("resolveLinearAuth", () => {
  let linearPath;
  let linearAppPath;

  afterEach(() => {
    for (const f of [linearPath, linearAppPath]) {
      if (f && fs.existsSync(f)) fs.rmSync(f);
    }
  });

  it("prefers the app credential when both linear.env and linear-app.env are present", () => {
    linearPath = path.join(os.tmpdir(), `moviecal-test-linear-${Date.now()}.env`);
    linearAppPath = path.join(os.tmpdir(), `moviecal-test-linear-app-${Date.now()}.env`);
    fs.writeFileSync(linearPath, "LINEAR_API_KEY=lin_api_personal\nLINEAR_TEAM_KEY=MOV\n", { mode: 0o600 });
    fs.writeFileSync(
      linearAppPath,
      "LINEAR_APP_CLIENT_ID=cid\nLINEAR_APP_CLIENT_SECRET=csecret\nLINEAR_APP_SCOPES=read,write\n",
      { mode: 0o600 },
    );

    const auth = resolveLinearAuth({ linearPath, linearAppPath });

    expect(auth).toEqual({
      mode: "app",
      teamKey: "MOV",
      appAuth: { clientId: "cid", clientSecret: "csecret", scopes: "read,write" },
    });
  });

  it("falls back to the personal API key when linear-app.env is absent", () => {
    linearPath = path.join(os.tmpdir(), `moviecal-test-linear-${Date.now()}.env`);
    linearAppPath = "/nonexistent/linear-app.env";
    fs.writeFileSync(linearPath, "LINEAR_API_KEY=lin_api_personal\nLINEAR_TEAM_KEY=MOV\n", { mode: 0o600 });

    const auth = resolveLinearAuth({ linearPath, linearAppPath });

    expect(auth).toEqual({ mode: "apiKey", teamKey: "MOV", apiKey: "lin_api_personal" });
  });

  it("reports mode 'none' when neither credential is configured", () => {
    const auth = resolveLinearAuth({ linearPath: "/nonexistent/linear.env", linearAppPath: "/nonexistent/linear-app.env" });
    expect(auth).toEqual({ mode: "none", teamKey: "MOV" });
  });
});
