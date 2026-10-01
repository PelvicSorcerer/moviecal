// MOV-401: native Codex cannot apply Seatbelt inside inherited Seatbelt.
// Use its installed exec-server transport instead. A trusted supervisor
// launches two sibling sandboxes; only the executor runs model commands.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildWorkerSandboxProfile, sanitizedWorkerEnvironment } from "./worker-guard.mjs";
import { validateOpenRouterTransport } from "./openrouter-transport.mjs";

export function verifyCodexVersion(binary) {
  const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH } }).trim();
  // Code mode must remain a pure tool-delegation isolate. A new runtime
  // version needs the native and live proof before this allowlist changes.
  if (version !== "codex-cli 0.157.1") throw new Error("unproved Codex containment version; requires codex-cli 0.157.1");
  return version;
}

export function resolveCodexExecutable(command = "codex", env = process.env) {
  const found = path.isAbsolute(command) ? command : String(env.PATH || "").split(path.delimiter)
    .map((dir) => path.join(dir, command)).find((file) => fs.existsSync(file));
  if (!found) throw new Error("Codex executable is unavailable");
  let binary = fs.realpathSync(found);
  if (binary.endsWith(".js")) {
    // The supported npm distribution's launcher would require allowing Node
    // in the harness guard. Resolve the vendor binary so no general purpose
    // interpreter can execute inside that guard.
    const packageRoot = path.dirname(path.dirname(binary));
    const packageName = `@openai/codex-darwin-${process.arch}`;
    let packageDir;
    try { packageDir = path.dirname(createRequire(binary).resolve(`${packageName}/package.json`)); }
    catch { packageDir = packageRoot; }
    const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    if (![packageName, "@openai/codex"].includes(metadata.name)) throw new Error("unrecognized Codex native package");
    binary = fs.realpathSync(path.join(packageDir, "vendor", process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin", "bin", "codex"));
  }
  fs.accessSync(binary, fs.constants.X_OK);
  const fd = fs.openSync(binary, "r");
  const magic = Buffer.alloc(4);
  try { fs.readSync(fd, magic); } finally { fs.closeSync(fd); }
  if (!['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(magic.toString("hex"))) {
    throw new Error("Codex containment requires an installed native Mach-O executable");
  }
  return binary;
}

export function prepareCodexContainment({ invocation, cwd, logDir, repositoryPaths, mode, home = os.homedir(),
  resolveExecutable = resolveCodexExecutable, verifyVersion = verifyCodexVersion, sourceEnvironment = process.env,
  openRouterTransport = null, openRouterFixture = false }) {
  const sandboxIndex = invocation.args.indexOf("--sandbox");
  if (!invocation.args.includes("exec") || sandboxIndex < 0 || invocation.args[sandboxIndex + 1] !== "workspace-write"
    || invocation.args.lastIndexOf("--sandbox") !== sandboxIndex || invocation.args.includes("--dangerously-bypass-approvals-and-sandbox")) {
    throw new Error("Codex containment requires the workspace-write routing contract");
  }
  const binary = resolveExecutable(invocation.command, sourceEnvironment);
  const repositories = [cwd, ...repositoryPaths.protectedRepositoryPaths]
    .map((dir) => fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir));
  const inRepository = (file) => repositories.some((dir) => file === dir || file.startsWith(`${dir}/`));
  if (inRepository(binary)) throw new Error("Codex native executable must be installed outside repository checkouts");
  const codeModeHost = resolveExecutable(path.join(path.dirname(binary), "codex-code-mode-host"), sourceEnvironment);
  // Stock code mode is a V8 isolate exposing tool delegates, not Node/Deno
  // or an OS scripting API. Commands/file operations still use exec-server.
  // No in-process fallback may move model JavaScript into the client.
  if (inRepository(codeModeHost)) {
    throw new Error("Codex native executable must be installed outside repository checkouts");
  }
  const version = verifyVersion(binary);
  const openRouter = openRouterTransport && validateOpenRouterTransport(openRouterTransport,
    { cwd, home, fixture: openRouterFixture });
  if (openRouter && invocation.args.some((arg) => /^model_providers?\./.test(arg) || /^model_provider=/.test(arg))) {
    throw new Error("OpenRouter transport refuses caller provider overrides");
  }
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-codex-")));
  try {
    const harnessHome = path.join(runtime, "harness");
    const executorHome = path.join(runtime, "executor");
    const harnessScratch = path.join(runtime, "harness-scratch");
    const executorScratch = path.join(runtime, "executor-scratch");
    for (const dir of [harnessHome, executorHome, harnessScratch, executorScratch]) fs.mkdirSync(dir, { mode: 0o700 });
    // Auth stays in the client, never the executor's environment/filesystem.
    // Do not copy credentials into the runtime or the preserved run logs.
    const auth = path.join(sourceEnvironment.CODEX_HOME || path.join(home, ".codex"), "auth.json");
    const authTarget = fs.existsSync(auth) ? fs.realpathSync(auth) : auth;
    if (!openRouter && fs.existsSync(auth)) fs.symlinkSync(authTarget, path.join(harnessHome, "auth.json"));

    const context = { worktreePath: cwd, mode, home, logDir, ...repositoryPaths };
    const executorProfile = path.join(logDir, "worker-sandbox.sb");
    const harnessProfile = path.join(logDir, "codex-harness.sb");
    fs.writeFileSync(executorProfile, buildWorkerSandboxProfile({ ...context,
      writablePaths: [cwd, executorHome, executorScratch], networkRole: "executor",
      unreadablePaths: [harnessHome, harnessScratch, auth, authTarget, ...(openRouter ? [openRouter.credentialPath] : [])],
    }), { mode: 0o600 });
    fs.writeFileSync(harnessProfile, buildWorkerSandboxProfile({ ...context,
      writablePaths: [harnessHome, harnessScratch], executablePaths: [binary, codeModeHost], networkRole: "harness",
      providerBroker: Boolean(openRouter), unreadablePaths: [executorHome, executorScratch, ...(openRouter ? [openRouter.credentialPath, auth, authTarget] : [])],
      immutablePaths: [path.join(harnessHome, "environments.toml"), path.join(harnessHome, "auth.json")],
    }), { mode: 0o600 });

    // Both profiles protect the per-run policy and supervisor from reads and
    // writes. Copy the supervisor out of the implementation-editable repo.
    const supervisor = path.join(logDir, "codex-supervisor.mjs");
    fs.copyFileSync(fileURLToPath(new URL("./codex-supervisor.mjs", import.meta.url)), supervisor);
    fs.chmodSync(supervisor, 0o600);
    let brokerConfig = null;
    if (openRouter) {
      const broker = path.join(logDir, "openrouter-broker.mjs");
      brokerConfig = path.join(logDir, "openrouter-broker.json");
      fs.copyFileSync(fileURLToPath(new URL("./openrouter-broker.mjs", import.meta.url)), broker);
      fs.chmodSync(broker, 0o600);
      const brokerPolicy = path.join(logDir, "openrouter-transport.mjs");
      fs.copyFileSync(fileURLToPath(new URL("./openrouter-transport.mjs", import.meta.url)), brokerPolicy);
      fs.chmodSync(brokerPolicy, 0o600);
      fs.writeFileSync(brokerConfig, JSON.stringify(openRouter), { mode: 0o600 });
    }
    const environment = Object.fromEntries(Object.entries(sanitizedWorkerEnvironment(sourceEnvironment, { worker: "codex" }))
      .filter(([key]) => ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "CI",
        "MOVIECAL_WORKER_SANDBOX", "MOVIECAL_IOS_SIM_LEASE_ID"].includes(key)));
    const executorEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) =>
      ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "CI", "MOVIECAL_WORKER_SANDBOX", "MOVIECAL_IOS_SIM_LEASE_ID"].includes(key)));
    Object.assign(executorEnvironment, { HOME: executorHome, CODEX_HOME: executorHome, TMPDIR: executorScratch });
    Object.assign(environment, { CODEX_HOME: harnessHome, TMPDIR: harnessScratch });
    // User config, hooks, plugins and a local fallback environment cannot
    // reintroduce execution in the network-capable client. The native client
    // guard permits only the installed Codex binary and stock code-mode host.
    const args = invocation.args.map((arg, index) => invocation.args[index - 1] === "--sandbox" ? "danger-full-access" : arg);
    if (openRouter) {
      const modelIndex = args.indexOf("--model");
      if (modelIndex < 0 || !args[modelIndex + 1]) throw new Error("OpenRouter transport requires an explicit routed model");
      args[modelIndex + 1] = openRouter.policy.model;
    }
    args.push("-c", "features.shell_snapshot=false", "-c", "features.shell_snapshot_v2=false",
      "-c", "features.plugins=false", "-c", "features.apps=false",
      "-c", 'web_search="disabled"',
      "-c", "features.code_mode_host={enabled=true,disable_in_process_fallback=true}",
      "-c", "allow_login_shell=false", "-c", `projects.${JSON.stringify(cwd)}.trust_level=\"untrusted\"`);
    const descriptor = path.join(logDir, "codex-launch.json");
    const transportPath = path.join(logDir, "codex-transport.json");
    fs.writeFileSync(descriptor, JSON.stringify({ binary, args, cwd, harnessHome, executorHome, executorScratch, executorProfile, harnessProfile,
      transportPath, ...(openRouter ? { broker: path.join(logDir, "openrouter-broker.mjs"), brokerConfig } : {}),
      // Environment values are passed by the parent, never persisted here.
      executorEnvironmentKeys: Object.keys(executorEnvironment),
    }), { mode: 0o600 });
    const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return { invocation: { command: process.execPath, args: [supervisor, descriptor] }, environment,
      runtime, cleanup: () => fs.rmSync(runtime, { recursive: true, force: true }),
      evidence: { arrangement: "codex-sibling-exec-server", version, nativeExecutable: binary, codeModeHost, executorProfile, harnessProfile, transportPath,
        executorProfileSha256: hash(executorProfile), harnessProfileSha256: hash(harnessProfile), launchSha256: hash(descriptor),
        ...(openRouter ? { providerTransport: "openrouter-broker-disabled-by-default", policyHash: openRouter.policy.hash } : {}) } };
  } catch (error) {
    fs.rmSync(runtime, { recursive: true, force: true });
    throw error;
  }
}
