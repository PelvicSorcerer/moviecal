// Trusted, per-run copy. Never interpret model output or execute a model
// command here. All children share this supervisor's managed process group.
import fs from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let executor;
let harness;
let finished = false;
let deadline;
const fail = (message) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  process.stderr.write(`Codex containment setup failed: ${message}\n`);
  harness?.kill("SIGKILL");
  executor?.kill("SIGKILL");
  process.exitCode = 1;
  process.stdin.destroy();
};
const executorEnv = Object.fromEntries(config.executorEnvironmentKeys.filter((key) => process.env[key] != null)
  .map((key) => [key, process.env[key]]));
Object.assign(executorEnv, { HOME: config.executorHome, CODEX_HOME: config.executorHome, TMPDIR: config.executorScratch });
// Reserve the address before profile application. A lost bind race fails
// setup; it never widens the permitted port range or falls back locally.
const reservation = net.createServer();
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
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
  harness = spawn("/usr/bin/sandbox-exec", ["-f", config.harnessProfile, config.binary, ...config.args],
    { cwd: config.cwd, env: { ...process.env, CODEX_EXEC_SERVER_URL: url }, stdio: ["pipe", "pipe", "pipe"] });
  harness.on("error", () => fail("client could not start"));
  harness.stdin.on("error", (error) => { if (error.code !== "EPIPE") fail("client input failed"); });
  process.stdin.pipe(harness.stdin);
  harness.stdout.pipe(process.stdout);
  harness.stderr.pipe(process.stderr);
  harness.on("exit", (code) => {
    if (finished) return;
    finished = true;
    executor.kill("SIGTERM");
    process.exitCode = code ?? 1;
    process.stdin.destroy();
  });
});
process.on("exit", () => clearTimeout(deadline));
