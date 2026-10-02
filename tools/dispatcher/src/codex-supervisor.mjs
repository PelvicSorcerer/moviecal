// Trusted, per-run copy. Never interpret model output or execute a model
// command here. All children share this supervisor's managed process group.
import fs from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let executor;
let harness;
let broker;
let finished = false;
let deadline;
const fail = (message) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  process.stderr.write(`Codex containment setup failed: ${message}\n`);
  harness?.kill("SIGKILL");
  executor?.kill("SIGKILL");
  broker?.kill("SIGKILL");
  process.exitCode = 1;
  process.stdin.destroy();
};
const executorEnv = Object.fromEntries(config.executorEnvironmentKeys.filter((key) => process.env[key] != null)
  .map((key) => [key, process.env[key]]));
Object.assign(executorEnv, { HOME: config.executorHome, CODEX_HOME: config.executorHome, TMPDIR: config.executorScratch });
const reservePort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const reserved = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return reserved;
};
let brokerPort;
let brokerToken;
if (config.broker) {
  brokerPort = await reservePort();
  brokerToken = randomBytes(32).toString("hex");
  broker = spawn(process.execPath, [config.broker, config.brokerConfig], {
    cwd: config.cwd, env: { PATH: process.env.PATH, HOME: config.executorHome,
      MOVIECAL_PROVIDER_BROKER_PORT: String(brokerPort), MOVIECAL_PROVIDER_BROKER_TOKEN: brokerToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  broker.on("error", () => fail("provider broker could not start"));
  broker.on("exit", () => { if (!finished) fail("provider broker exited before worker completion"); });
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000);
    let output = "";
    broker.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 64 || !output.includes("\n")) return;
      clearTimeout(timer);
      resolve(output === "ready\n");
    });
    broker.once("exit", () => { clearTimeout(timer); resolve(false); });
  });
  if (!ready) { fail("provider broker failed readiness"); process.exit(); }
}
// Reserve the address before profile application. A lost bind race fails
// setup; it never widens the permitted port range or falls back locally.
const port = await reservePort();
const endpoint = `ws://127.0.0.1:${port}`;
fs.writeFileSync(config.transportPath, JSON.stringify({ endpoint, sandboxParameter: `EXECUTOR_LISTENER=localhost:${port}` }), { mode: 0o600 });
executor = spawn("/usr/bin/sandbox-exec", ["-D", `EXECUTOR_LISTENER=localhost:${port}`, "-f", config.executorProfile, config.binary, "exec-server", "--listen", endpoint],
  { cwd: config.cwd, env: executorEnv, stdio: ["ignore", "pipe", "pipe"] });
executor.on("error", () => fail("executor could not start"));
executor.stderr.pipe(process.stderr, { end: false });
executor.on("exit", () => { if (!finished) fail("executor exited before worker completion"); });
deadline = setTimeout(() => fail("executor startup timed out"), 10000);
let startup = "";
executor.stdout.on("data", (chunk) => {
  if (harness || finished) return;
  startup += chunk.toString();
  if (startup.length > 4096) return fail("invalid executor startup response");
  if (!startup.includes("\n")) return;
  const url = startup.split("\n")[0].trim();
  if (url !== endpoint) {
    return fail("executor did not return a loopback endpoint");
  }
  clearTimeout(deadline);
  // This file is generated before the guarded client starts. The client's
  // profile must protect it against replacement, including ancestor moves.
  fs.writeFileSync(`${config.harnessHome}/environments.toml`,
    `default = "worker"\ninclude_local = false\n[[environments]]\nid = "worker"\nurl = ${JSON.stringify(url)}\n`, { mode: 0o600 });
  const providerArgs = brokerPort ? ["-c", 'model_provider="moviecal_openrouter"', "-c",
    `model_providers.moviecal_openrouter={name="moviecal_openrouter",base_url="http://127.0.0.1:${brokerPort}/v1",wire_api="responses",env_key="MOVIECAL_PROVIDER_BROKER_TOKEN",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`] : [];
  harness = spawn("/usr/bin/sandbox-exec", ["-D", `EXECUTOR_LISTENER=localhost:${port}`,
    ...(brokerPort ? ["-D", `PROVIDER_BROKER=localhost:${brokerPort}`] : []),
    "-f", config.harnessProfile, config.binary, ...config.args, ...providerArgs],
    { cwd: config.cwd, env: { ...process.env, CODEX_EXEC_SERVER_URL: url,
      ...(brokerToken ? { MOVIECAL_PROVIDER_BROKER_TOKEN: brokerToken } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
  harness.on("error", () => fail("client could not start"));
  harness.stdin.on("error", (error) => { if (error.code !== "EPIPE") fail("client input failed"); });
  process.stdin.pipe(harness.stdin);
  harness.stdout.pipe(process.stdout);
  harness.stderr.pipe(process.stderr);
  harness.on("exit", (code) => {
    if (finished) return;
    finished = true;
    executor.kill("SIGTERM");
    broker?.kill("SIGTERM");
    let routeError = null;
    if (config.broker) {
      try {
        const attemptId = JSON.parse(fs.readFileSync(config.brokerConfig, "utf8")).accounting?.attemptId;
        const rows = fs.readFileSync(path.join(path.dirname(config.brokerConfig), "routing-decisions.jsonl"), "utf8")
          .trim().split("\n").map(JSON.parse).filter((row) => row.kind === "routed-request"
            && (!attemptId || row.attemptId === attemptId));
        routeError = rows.find((row) => row.error)?.error || (rows.length ? null : "missing-provider-evidence");
      } catch { routeError = "missing-provider-evidence"; }
    }
    if (routeError) process.stderr.write(`Jev route stopped: ${/^[a-z0-9_-]{1,80}$/.test(routeError) ? routeError : "invalid-provider-evidence"}\n`);
    process.exitCode = routeError ? 1 : code ?? 1;
    process.stdin.destroy();
  });
});
process.on("exit", () => clearTimeout(deadline));
