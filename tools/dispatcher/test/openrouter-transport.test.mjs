import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOpenRouterRequest, requiredSecretPresent, validateOpenRouterTransport, OPENROUTER_MODEL } from "../src/openrouter-transport.mjs";
import { prepareCodexContainment } from "../src/codex-containment.mjs";
import { workerInvocation } from "../src/worker-routing.mjs";

let root, containment;
afterEach(() => { containment?.cleanup(); if (root) fs.rmSync(root, { recursive: true, force: true }); containment = null; });
function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mov425-unit-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "worktree");
  const logDir = path.join(root, "logs");
  const store = path.join(home, ".config", "moviecal");
  for (const dir of [store, cwd, logDir]) fs.mkdirSync(dir, { recursive: true });
  const credentialPath = path.join(store, "openrouter-jev.key");
  fs.writeFileSync(credentialPath, "fake-key-only\n", { mode: 0o600 });
  const transport = { enabled: true, credentialPath, upstream: "http://127.0.0.1:12345/v1/responses",
    policy: { hash: "a".repeat(64), model: OPENROUTER_MODEL, providers: ["FixtureProvider"], zdr: true,
      dataCollection: "deny", promptLogging: false, keyId: "fixture-key-id", workspaceId: "fixture-workspace",
      keyLimitUsd: 75, spendCeilingUsd: 75, ownerReviewed: true } };
  return { home, cwd, logDir, transport };
}
function prepare({ home, cwd, logDir, transport }) {
  return prepareCodexContainment({ invocation: workerInvocation("codex", "strong"), cwd, home, logDir,
    repositoryPaths: { protectedRepositoryPaths: [path.join(root, "sibling")], gitMetadataPaths: [path.join(root, "main/.git")] },
    mode: "implementation", sourceEnvironment: { HOME: home, PATH: "/usr/bin", OPENROUTER_API_KEY: "must-not-inherit" },
    resolveExecutable: (command) => command === "codex" ? "/installed/codex" : command,
    verifyVersion: () => "codex-cli 0.157.1", openRouterTransport: transport, openRouterFixture: true });
}
describe("OpenRouter transport policy", () => {
  it("uses the dedicated file for the named needs-secrets gate, never env.local", () => {
    const opts = setup();
    const envLocalPath = path.join(root, "env.local");
    fs.writeFileSync(envLocalPath, "placeholder\n");
    expect(requiredSecretPresent("openrouter-jev", { home: opts.home, envLocalPath })).toBe(true);
    expect(requiredSecretPresent("TMDB_API_KEY", { home: opts.home, envLocalPath })).toBe(true);
    fs.chmodSync(opts.transport.credentialPath, 0o644);
    expect(requiredSecretPresent("openrouter-jev", { home: opts.home, envLocalPath })).toBe(false);
    fs.unlinkSync(opts.transport.credentialPath);
    expect(requiredSecretPresent("openrouter-jev", { home: opts.home, envLocalPath })).toBe(false);
  });
  it("injects restrictive provider policy and rejects caller overrides or another model", () => {
    const { transport } = setup();
    const body = buildOpenRouterRequest({ model: OPENROUTER_MODEL, input: "fixture" }, transport.policy);
    expect(body.provider).toEqual({ order: ["FixtureProvider"], allow_fallbacks: false,
      data_collection: "deny", zdr: true });
    expect(() => buildOpenRouterRequest({ model: OPENROUTER_MODEL, provider: { zdr: false } }, transport.policy)).toThrow(/policy/);
    expect(() => buildOpenRouterRequest({ model: "openai/gpt-6" }, transport.policy)).toThrow(/policy/);
  });
  it("keeps the key out of launch artifacts and both worker environments", () => {
    const opts = setup(); containment = prepare(opts);
    const launch = JSON.parse(fs.readFileSync(containment.invocation.args[1], "utf8"));
    const brokerConfig = fs.readFileSync(launch.brokerConfig, "utf8");
    const harness = fs.readFileSync(launch.harnessProfile, "utf8");
    const executor = fs.readFileSync(launch.executorProfile, "utf8");
    expect(launch.args[launch.args.indexOf("--model") + 1]).toBe(OPENROUTER_MODEL);
    expect(launch.args).not.toContain("fake-key-only");
    expect(JSON.stringify(launch) + brokerConfig + JSON.stringify(containment.environment)).not.toContain("fake-key-only");
    expect(containment.environment).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(launch.executorEnvironmentKeys).not.toContain("MOVIECAL_PROVIDER_BROKER_TOKEN");
    expect(harness).toContain('remote tcp (param "PROVIDER_BROKER")');
    expect(harness).not.toContain("(allow network-outbound)");
    expect(harness).toContain(`(deny file-read* (subpath "${opts.transport.credentialPath}"))`);
    expect(executor).toContain(`(deny file-read* (subpath "${opts.transport.credentialPath}"))`);
    expect(fs.existsSync(path.join(launch.harnessHome, "auth.json"))).toBe(false);
  });
  it.each([
    ["missing", (o) => fs.unlinkSync(o.transport.credentialPath)],
    ["world-readable", (o) => fs.chmodSync(o.transport.credentialPath, 0o644)],
    ["bad endpoint", (o) => { o.transport.upstream = "http://localhost:12345/v1/responses"; }],
    ["wrong model", (o) => { o.transport.policy.model = "openai/gpt-6"; }],
    ["logging enabled", (o) => { o.transport.policy.promptLogging = true; }],
    ["spend over cap", (o) => { o.transport.policy.spendCeilingUsd = 76; }],
    ["no owner review", (o) => { o.transport.policy.ownerReviewed = false; }],
  ])("fails closed on %s", (_label, change) => {
    const opts = setup(); change(opts);
    expect(() => prepare(opts)).toThrow(/OpenRouter/);
    expect(fs.readdirSync(opts.logDir)).toEqual([]);
  });
  it("rejects a fake endpoint and unapproved hash in production mode", () => {
    const opts = setup();
    expect(() => validateOpenRouterTransport(opts.transport, { cwd: opts.cwd, home: opts.home })).toThrow(/policy/);
  });
  it("rejects a provider override from the caller", () => {
    const opts = setup();
    const invocation = workerInvocation("codex", "strong");
    invocation.args.push("-c", 'model_provider="fixture"');
    expect(() => prepareCodexContainment({ invocation, cwd: opts.cwd, home: opts.home, logDir: opts.logDir,
      repositoryPaths: { protectedRepositoryPaths: [], gitMetadataPaths: [] }, mode: "implementation",
      resolveExecutable: (command) => command === "codex" ? "/installed/codex" : command,
      verifyVersion: () => "codex-cli 0.157.1", openRouterTransport: opts.transport, openRouterFixture: true })).toThrow(/provider overrides/);
  });
});
