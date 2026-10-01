#!/usr/bin/env node
// MOV-436 disposable, installed-Claude proof. No production adapter or secret.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { buildWorkerSandboxProfile, repositoryGuardPaths } from "../src/worker-guard.mjs";
import { captureVerificationEvidence } from "../src/readiness-evidence.mjs";

if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
  throw new Error("MOV-436 proof requires native macOS Seatbelt");
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mov436-proof-")));
const keep = process.env.MOV436_KEEP_EVIDENCE === "1";
const main = path.join(root, "main");
const own = path.join(root, "own");
const sibling = path.join(root, "sibling");
const home = path.join(root, "fake-home");
const scratch = path.join(root, "scratch");
const claudeBinary = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
const toolPath = [...new Set([path.dirname(process.execPath), path.dirname(claudeBinary), "/usr/bin", "/bin"])].join(":");
const summary = { platform: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
  claudeVersion: execFileSync(claudeBinary, ["--version"], { encoding: "utf8" }).trim(), modes: {} };

function git(args) { execFileSync("git", args, { cwd: main, stdio: "ignore" }); }
function jsonEvents(text) { return text.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function nodeShell(code) { return `node -e '${String(code).replaceAll("'", "'\\''")}'`; }
async function listen(server, target = [0, "127.0.0.1"]) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(...target, resolve); });
  return server.address();
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }
async function connectPositive(target) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(target);
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  });
}
function stream(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
function modelResponse(index, tool) {
  const block = tool ? { type: "tool_use", id: `toolu_fixture_${index}`, name: tool.name, input: {} } : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "Fixture complete." };
  return [
    { type: "message_start", message: { id: `msg_fixture_${index}`, type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
}
function runGuardedCommand(command, profile, ledger) {
  // The broker is trusted code outside the client sandbox. It never executes
  // model text itself; every command goes through this one strict profile.
  const id = randomUUID();
  if (!fs.existsSync(profile)) {
    const result = { id, command, exitCode: null, error: "guard missing" };
    ledger.push(result); return result;
  }
  const child = spawnSync("/usr/bin/sandbox-exec", ["-D", "EXECUTOR_LISTENER=localhost:1", "-f", profile, "/bin/zsh", "-c", command],
    { cwd: own, encoding: "utf8", timeout: 8000,
      env: { PATH: toolPath, HOME: scratch, TMPDIR: scratch, MOVIECAL_WORKER_SANDBOX: "1" } });
  const result = { id, command, exitCode: child.status, stdout: (child.stdout || "").slice(0, 1200),
    stderr: (child.stderr || "").slice(0, 1200), error: child.error?.code || null };
  ledger.push(result);
  return result;
}
function correlatedVerify(events, ledger) {
  const toolUses = events.flatMap(event => event.message?.content || []).filter(item => item?.type === "tool_use");
  const results = new Map(events.flatMap(event => event.message?.content || []).filter(item => item?.type === "tool_result")
    .map(item => [item.tool_use_id, item]));
  const matches = toolUses.filter(item => item.name === "mcp__broker__run" && item.input?.command === "npm run verify");
  if (matches.length !== 1) return "incomplete";
  const linked = results.get(matches[0].id);
  if (!linked || !Array.isArray(linked.content) || linked.content.length !== 1) return "incomplete";
  let body;
  try { body = JSON.parse(linked.content[0].text); } catch { return "incomplete"; }
  const trusted = ledger.filter(item => item.id === body.id && item.command === "npm run verify");
  return trusted.length === 1 && trusted[0].exitCode === 0 && body.exitCode === 0 ? "passed" : "incomplete";
}

async function runMode(mode, repositories, tcpPort, unixPath, credential) {
  const strictProfile = path.join(root, `${mode}-command.sb`);
  const clientProfile = path.join(root, `${mode}-client.sb`);
  fs.writeFileSync(strictProfile, buildWorkerSandboxProfile({ worktreePath: own, mode, home, ...repositories,
    networkRole: "executor", writablePaths: [own, scratch], unreadablePaths: [path.join(home, ".claude")] }));
  fs.writeFileSync(clientProfile, buildWorkerSandboxProfile({ worktreePath: own, mode, home, ...repositories }));
  const ledger = [];
  const mcpCalls = [];
  const mcp = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    let message; try { message = JSON.parse(raw); } catch { message = {}; }
    if (req.method === "GET") { res.writeHead(405); res.end(); return; }
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "broker", version: "0.1.0" } };
    else if (message.method === "tools/list") result = { tools: [{ name: "run", description: "Run a disposable fixture command in the separate native sandbox",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } }] };
    else if (message.method === "tools/call") {
      const input = message.params?.arguments;
      if (message.params?.name !== "run" || typeof input?.command !== "string" || Object.keys(input).join() !== "command") {
        result = { isError: true, content: [{ type: "text", text: "invalid broker request" }] };
      } else {
        const execution = runGuardedCommand(input.command, strictProfile, ledger);
        mcpCalls.push({ name: message.params.name, command: input.command, exitCode: execution.exitCode });
        result = { isError: execution.exitCode !== 0, content: [{ type: "text", text: JSON.stringify(execution) }] };
      }
    } else result = {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const mcpPort = (await listen(mcp)).port;
  const config = path.join(root, `${mode}-mcp.json`);
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { broker: { type: "http", url: `http://127.0.0.1:${mcpPort}/mcp` } } }));
  const tcpCode = `require('net').connect(${tcpPort},'127.0.0.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(2)})`;
  const tcp = nodeShell(tcpCode);
  const udp = nodeShell(`const s=require('dgram').createSocket('udp4');s.on('error',e=>{console.log(e.code);process.exit(2)});s.send(Buffer.from('fixture'),${tcpPort},'127.0.0.1',e=>{console.log(e?.code||'SENT');s.close()})`);
  const unix = nodeShell(`require('net').connect(${JSON.stringify(unixPath)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(2)})`);
  const descendant = nodeShell(`const r=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(tcpCode)}],{encoding:'utf8'});console.log(r.stdout.trim());process.exit(r.status)`);
  const forbidden = nodeShell(`for(const p of ${JSON.stringify([path.join(sibling, "sibling.txt"), path.join(main, "AGENTS.md"), credential])}){try{require('fs').readFileSync(p);console.log('READ')}catch(e){console.log(e.code)}}`);
  const protectedWrite = nodeShell(`for(const p of ${JSON.stringify([path.join(own, "AGENTS.md"), path.join(own, "docs", "operators", "policy.md"), path.join(own, ".git"), path.join(repositories.gitMetadataPaths.at(-1), "config")])}){try{require('fs').writeFileSync(p,'escape');console.log('WROTE')}catch(e){console.log(e.code)}}`);
  const credentialAbsent = nodeShell("console.log(process.env.ANTHROPIC_API_KEY || 'ABSENT')");
  const calls = [
    { name: "Read", input: { file_path: path.join(own, "AGENTS.md") } },
    { name: "Read", input: { file_path: path.join(own, "src", "edit.txt") } },
    { name: "Edit", input: { file_path: path.join(own, "src", "edit.txt"), old_string: "before", new_string: "after" } },
    { name: "mcp__broker__run", input: { command: nodeShell("require('fs').writeFileSync('src/from-broker.txt','allowed')") } },
    { name: "mcp__broker__run", input: { command: "npm run verify" } },
    ...[tcp, udp, unix, descendant, forbidden, protectedWrite, "security -h", "osascript -e 'return 1'", credentialAbsent].map(command => ({ name: "mcp__broker__run", input: { command } })),
    { name: "Bash", input: { command: "echo should-not-run > src/bash-escape.txt" } },
  ];
  let count = 0;
  const providerRequests = [];
  const provider = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    providerRequests.push({ method: req.method, path: req.url });
    if (req.method === "HEAD") { res.writeHead(200); res.end(); return; }
    stream(res, modelResponse(++count, calls[count - 1]));
  });
  const providerPort = (await listen(provider)).port;
  const env = { PATH: toolPath, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_API_KEY: "fixture-not-secret", ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}`,
    CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_TELEMETRY: "1", MOVIECAL_WORKER_SANDBOX: "1" };
  const args = ["-f", clientProfile, claudeBinary, "--bare", "-p", "Run only the fixture tool requests", "--model", "claude-haiku-4-5",
    "--mcp-config", config, "--strict-mcp-config", "--tools", "Read,Edit,mcp__broker__run",
    "--allowedTools", "Read,Edit,mcp__broker__run", "--permission-prompts", "none", "--disable-slash-commands",
    "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
  const child = spawn("/usr/bin/sandbox-exec", args, { cwd: own, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 40000);
  const exitCode = await new Promise(resolve => child.once("exit", resolve)); clearTimeout(timer);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  await close(provider); await close(mcp);
  const events = jsonEvents(stdout);
  const init = events.find(event => event.type === "system" && event.subtype === "init");
  const toolResults = events.flatMap(event => event.message?.content || []).filter(item => item?.type === "tool_result");
  const logDir = path.join(root, `${mode}-transcript`); fs.mkdirSync(logDir); fs.writeFileSync(path.join(logDir, "stdout.log"), stdout);
  const currentReadiness = captureVerificationEvidence(logDir).status;
  const result = { exitCode, providerPosts: providerRequests.filter(item => item.method === "POST").length,
    tools: init?.tools || [], mcpCalls, brokerResults: ledger.map(item => ({ command: item.command, exitCode: item.exitCode, stdout: item.stdout.trim(), stderr: item.stderr.trim(), error: item.error })),
    controls: {
      tcp: ledger[2]?.stdout.trim(), udp: ledger[3]?.stdout.trim(), unix: ledger[4]?.stdout.trim(),
      descendant: ledger[5]?.stdout.trim(), protectedReads: ledger[6]?.stdout.trim().split("\n"),
      protectedWrites: ledger[7]?.stdout.trim().split("\n"), security: ledger[8]?.stderr.trim(),
      osascript: { exitCode: ledger[9]?.exitCode, stdout: ledger[9]?.stdout.trim(), stderr: ledger[9]?.stderr.trim() },
      commandCredential: ledger[10]?.stdout.trim(),
    },
    readGuidance: toolResults.some(item => String(item.content).includes("fixture guidance")),
    editedFile: fs.readFileSync(path.join(own, "src", "edit.txt"), "utf8") === "after\n",
    brokerWrote: fs.readFileSync(path.join(own, "src", "from-broker.txt"), "utf8") === "allowed",
    built: fs.readFileSync(path.join(own, "src", "verified.txt"), "utf8") === "passed",
    bashRejected: toolResults.some(item => item.is_error && String(item.content).includes("No such tool available: Bash")),
    correlatedVerify: correlatedVerify(events, ledger), currentReadiness,
    stderr: stderr.slice(0, 300),
  };
  return result;
}

try {
  for (const dir of [main, home, scratch, path.join(home, ".claude")]) fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Fixture"]);
  fs.writeFileSync(path.join(main, "AGENTS.md"), "fixture guidance\n");
  fs.mkdirSync(path.join(main, "src")); fs.mkdirSync(path.join(main, "docs", "operators"), { recursive: true });
  fs.writeFileSync(path.join(main, "src", "edit.txt"), "before\n");
  fs.writeFileSync(path.join(main, "docs", "operators", "policy.md"), "policy\n");
  fs.writeFileSync(path.join(main, "package.json"), JSON.stringify({ scripts: { verify: "node verify.cjs" } }));
  fs.writeFileSync(path.join(main, "verify.cjs"), "require('fs').writeFileSync('src/verified.txt','passed')\n");
  git(["add", "."]); git(["commit", "-qm", "fixture"]);
  git(["worktree", "add", "-qb", "own", own]); git(["worktree", "add", "-qb", "sibling", sibling]);
  fs.writeFileSync(path.join(sibling, "sibling.txt"), "forbidden\n");
  const credential = path.join(home, ".config", "moviecal", "linear.env");
  fs.mkdirSync(path.dirname(credential), { recursive: true }); fs.writeFileSync(credential, "FAKE=fixture\n");
  const tcp = net.createServer(socket => socket.end()); const tcpPort = (await listen(tcp)).port;
  const unixPath = path.join(root, "positive.sock"); const unix = net.createServer(socket => socket.end()); await listen(unix, [unixPath]);
  await connectPositive({ host: "127.0.0.1", port: tcpPort });
  await connectPositive(unixPath);
  summary.positiveListeners = { tcp: "connected", unix: "connected" };
  const repositories = repositoryGuardPaths(own, undefined, undefined, home);
  for (const mode of ["implementation", "repair"]) {
    for (const file of ["src/edit.txt", "src/from-broker.txt", "src/verified.txt", "src/bash-escape.txt"]) fs.rmSync(path.join(own, file), { force: true });
    fs.writeFileSync(path.join(own, "src", "edit.txt"), "before\n");
    summary.modes[mode] = await runMode(mode, repositories, tcpPort, unixPath, credential);
  }
  await close(tcp); await close(unix);
  const missingLedger = [];
  const missing = runGuardedCommand("echo should-not-run > src/missing-guard.txt", path.join(root, "missing.sb"), missingLedger);
  summary.missingGuard = { exitCode: missing.exitCode, error: missing.error, escaped: fs.existsSync(path.join(own, "src", "missing-guard.txt")) };
  const invalidProfile = path.join(root, "invalid.sb"); fs.writeFileSync(invalidProfile, "(version 1)\n(");
  const invalidLedger = [];
  const invalid = runGuardedCommand("echo should-not-run > src/invalid-guard.txt", invalidProfile, invalidLedger);
  summary.invalidGuard = { exitCode: invalid.exitCode, error: invalid.error,
    escaped: fs.existsSync(path.join(own, "src", "invalid-guard.txt")) };
  for (const mode of ["implementation", "repair"]) {
    const value = summary.modes[mode];
    assert.equal(value.exitCode, 0);
    assert.ok(value.providerPosts > 0);
    assert.deepEqual(value.tools, ["Edit", "Read", "mcp__broker__run"]);
    assert.equal(value.readGuidance, true);
    assert.equal(value.editedFile, true);
    assert.equal(value.brokerWrote, true);
    assert.equal(value.built, true);
    assert.equal(value.bashRejected, true);
    assert.equal(value.correlatedVerify, "passed");
    assert.equal(value.currentReadiness, "incomplete");
    assert.deepEqual([value.controls.tcp, value.controls.udp, value.controls.unix, value.controls.descendant],
      ["EPERM", "EPERM", "EPERM", "EPERM"]);
    assert.deepEqual(value.controls.protectedReads, ["EPERM", "EPERM", "EPERM"]);
    assert.deepEqual(value.controls.protectedWrites,
      mode === "repair" ? ["EPERM", "EPERM", "EPERM", "EPERM"] : ["EPERM", "WROTE", "EPERM", "EPERM"]);
    assert.match(value.controls.security, /operation not permitted/);
    assert.deepEqual(value.controls.osascript, { exitCode: 0, stdout: "1", stderr: "" });
    assert.equal(value.controls.commandCredential, "ABSENT");
  }
  assert.equal(summary.missingGuard.exitCode, null);
  assert.equal(summary.missingGuard.escaped, false);
  assert.notEqual(summary.invalidGuard.exitCode, 0);
  assert.equal(summary.invalidGuard.escaped, false);
  assert.deepEqual(summary.positiveListeners, { tcp: "connected", unix: "connected" });
  fs.writeFileSync(path.join(root, "proof.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ evidence: keep ? path.join(root, "proof.json") : null, summary }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ evidence: keep ? root : null, error: error.message }));
  process.exitCode = 1;
} finally {
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
}
