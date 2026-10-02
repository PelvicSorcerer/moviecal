#!/usr/bin/env node
// MOV-415 disposable Mac proof. No real credential, daemon, or production profile change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { buildWorkerSandboxProfile, repositoryGuardPaths } from "../src/worker-guard.mjs";
import { captureVerificationEvidence } from "../src/readiness-evidence.mjs";

if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
  throw new Error("MOV-415 proof requires native macOS Seatbelt");
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mov415-proof-")));
const main = path.join(root, "main");
const own = path.join(root, "own");
const sibling = path.join(root, "sibling");
const home = path.join(root, "fake-home");
const log = path.join(root, "proof.json");
const keepEvidence = process.env.MOV415_KEEP_EVIDENCE === "1";
const results = { claudeVersion: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(), modes: {} };
function git(args) { return execFileSync("git", args, { cwd: main, encoding: "utf8" }); }
function parseEvents(text) { return text.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function responseEvents(count, tool) {
  const block = tool ? { type: "tool_use", id: `toolu_fixture_${count}`, name: tool.name, input: {} } : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "Fixture complete." };
  return [
    { type: "message_start", message: { id: `msg_fixture_${count}`, type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
}
function runNative(profile, code, env = {}, parameters = []) {
  const child = spawnSync("/usr/bin/sandbox-exec", [...parameters.flatMap(value => ["-D", value]), "-f", profile, process.execPath, "-e", code],
    { cwd: own, encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, HOME: home, ...env } });
  return { exitCode: child.status, stdout: child.stdout.trim(), stderr: child.stderr.trim() };
}
async function listen(server) { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return server.address().port; }
async function close(server) { await new Promise(resolve => server.close(resolve)); }
async function runClaude(mode, profile, tcpPort) {
  let count = 0;
  const tools = [
    { name: "Read", input: { file_path: path.join(own, "AGENTS.md") } },
    { name: "Bash", input: { command: "node -e \"require('fs').writeFileSync('src/fixture.txt','allowed')\"" } },
    { name: "Bash", input: { command: "npm run verify" } },
    { name: "Bash", input: { command: `node -e "require('net').connect(${tcpPort},'127.0.0.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(2)})"` } },
  ];
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, bytes: body.length });
    if (req.method === "HEAD") { res.writeHead(200); res.end(); return; }
    const events = responseEvents(++count, tools[count - 1]);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const port = await listen(provider);
  const env = {
    PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_API_KEY: "fixture-not-secret", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_TELEMETRY: "1", MOVIECAL_WORKER_SANDBOX: "1",
  };
  const args = ["-f", profile, "claude", "--bare", "-p", "Run only the fixture calls", "--model", "claude-haiku-4-5",
    "--tools", "Read,Bash", "--allowedTools", "Read,Bash", "--permission-prompts", "none",
    "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
  const child = spawn("/usr/bin/sandbox-exec", args, { cwd: own, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  const exitCode = await new Promise(resolve => child.once("exit", resolve));
  clearTimeout(timer);
  await close(provider);
  const events = parseEvents(stdout);
  const actions = events.flatMap(event => event.message?.content || []).filter(item => ["tool_use", "tool_result"].includes(item.type));
  const logDir = path.join(root, `claude-${mode}`); fs.mkdirSync(logDir);
  fs.writeFileSync(path.join(logDir, "stdout.log"), stdout);
  return { exitCode, requests, toolUses: actions.filter(item => item.type === "tool_use").map(item => ({ name: item.name, command: item.input?.command ?? null })),
    toolResults: actions.filter(item => item.type === "tool_result").map(item => ({ id: item.tool_use_id, content: String(item.content).slice(0, 200) })),
    providerResponse: requests.some(item => item.path?.startsWith("/v1/messages")),
    verifyEvidence: captureVerificationEvidence(logDir).status,
    allowedWrite: fs.existsSync(path.join(own, "src/fixture.txt")),
    nestedFailure: /sandbox_apply: Operation not permitted/.test(stdout + stderr),
    stderr: stderr.slice(0, 250),
  };
}
try {
  fs.mkdirSync(main); fs.mkdirSync(home); fs.mkdirSync(path.join(home, ".claude"));
  git(["init", "-q"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Fixture"]);
  fs.writeFileSync(path.join(main, "AGENTS.md"), "fixture guidance\n");
  fs.mkdirSync(path.join(main, "docs", "operators"), { recursive: true });
  fs.writeFileSync(path.join(main, "docs", "operators", "protected.md"), "fixture\n");
  fs.mkdirSync(path.join(main, "src"));
  fs.writeFileSync(path.join(main, "src", ".keep"), "");
  fs.writeFileSync(path.join(main, "package.json"), JSON.stringify({ scripts: { verify: "node verify.cjs" } }));
  fs.writeFileSync(path.join(main, "verify.cjs"), "require('fs').writeFileSync('src/verified.txt','passed')\n");
  git(["add", "."]); git(["commit", "-qm", "fixture"]);
  git(["worktree", "add", "-qb", "own", own]); git(["worktree", "add", "-qb", "sibling", sibling]);
  fs.writeFileSync(path.join(sibling, "sibling-only.txt"), "forbidden\n");
  const credential = path.join(home, ".config", "moviecal", "linear.env");
  fs.mkdirSync(path.dirname(credential), { recursive: true }); fs.writeFileSync(credential, "FAKE=fixture\n");
  const socket = net.createServer(socket => socket.end());
  const tcpPort = await listen(socket);
  const unixPath = path.join(root, "positive.sock");
  const unix = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => { unix.once("error", reject); unix.listen(unixPath, resolve); });
  const repositories = repositoryGuardPaths(own, undefined, undefined, home);
  for (const mode of ["implementation", "repair"]) {
    fs.rmSync(path.join(own, "src", "fixture.txt"), { force: true });
    fs.rmSync(path.join(own, "src", "verified.txt"), { force: true });
    const profile = path.join(root, `${mode}.sb`);
    fs.writeFileSync(profile, buildWorkerSandboxProfile({ worktreePath: own, mode, home, ...repositories }));
    const nativeTcp = runNative(profile, `require('net').connect(${tcpPort},'127.0.0.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(2)})`);
    const nativeForbidden = runNative(profile, `for(const p of ${JSON.stringify([sibling + "/sibling-only.txt", path.join(main, "AGENTS.md"), credential])}){try{require('fs').readFileSync(p);console.log('READ')}catch(e){console.log(e.code)}}`);
    const nativeGitWrite = runNative(profile, `try{require('fs').writeFileSync(${JSON.stringify(path.join(own, ".git"))},'escape');console.log('WROTE')}catch(e){console.log(e.code)}`);
    const nativeSharedGitWrite = runNative(profile, `try{require('fs').writeFileSync(${JSON.stringify(path.join(repositories.gitMetadataPaths.at(-1), "config"))},'escape');console.log('WROTE')}catch(e){console.log(e.code)}`);
    const nativeProtectedWrite = runNative(profile, `for(const p of ${JSON.stringify([path.join(own, "AGENTS.md"), path.join(own, "docs", "operators", "protected.md")])}){try{require('fs').writeFileSync(p,'escape');console.log('WROTE')}catch(e){console.log(e.code)}}`);
    const descendantTcp = runNative(profile, `const r=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(`require('net').connect(${tcpPort},'127.0.0.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(2)})`)}],{encoding:'utf8'});console.log(JSON.stringify({status:r.status,stdout:r.stdout.trim()}))`);
    const nativeUdp = runNative(profile, `const s=require('dgram').createSocket('udp4');s.on('error',e=>{console.log(e.code);process.exit(2)});s.send(Buffer.from('fixture'),${tcpPort},'127.0.0.1',e=>{console.log(e?.code||'SENT');s.close()})`);
    const nativeUnix = runNative(profile, `require('net').connect(${JSON.stringify(unixPath)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(2)})`);
    results.modes[mode] = { nativeTcp, nativeUdp, nativeUnix, descendantTcp, nativeForbidden, nativeGitWrite, nativeSharedGitWrite, nativeProtectedWrite, claude: await runClaude(mode, profile, tcpPort) };
  }
  const pureAllow = path.join(root, "pure-allow.sb"); fs.writeFileSync(pureAllow, "(version 1)\n(allow default)\n");
  const oneDeny = path.join(root, "one-deny.sb"); fs.writeFileSync(oneDeny, "(version 1)\n(allow default)\n(deny file-write* (literal \"/private/tmp/mov415-never\"))\n");
  for (const [name, profile] of [["pureAllow", pureAllow], ["oneDeny", oneDeny], ["current", path.join(root, "implementation.sb")]]) {
    results[`nested${name}`] = runNative(profile, "const r=require('child_process').spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/bin/echo','inner-ok'],{encoding:'utf8'});console.log(JSON.stringify({status:r.status,stdout:r.stdout.trim(),stderr:r.stderr.trim()}))");
  }
  const strict = path.join(root, "strict-command.sb");
  fs.writeFileSync(strict, buildWorkerSandboxProfile({ worktreePath: own, mode: "implementation", home, ...repositories,
    writablePaths: [own, path.join(root, "strict-scratch")], networkRole: "executor" }));
  fs.mkdirSync(path.join(root, "strict-scratch"));
  results.strictCommand = {
    tcp: runNative(strict, `require('net').connect(${tcpPort},'127.0.0.1').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(2)})`, {}, ["EXECUTOR_LISTENER=localhost:1"]),
    udp: runNative(strict, `const s=require('dgram').createSocket('udp4');s.on('error',e=>{console.log(e.code);process.exit(2)});s.send(Buffer.from('fixture'),${tcpPort},'127.0.0.1',e=>{console.log(e?.code||'SENT');s.close()})`, {}, ["EXECUTOR_LISTENER=localhost:1"]),
    unix: runNative(strict, `require('net').connect(${JSON.stringify(unixPath)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(2)})`, {}, ["EXECUTOR_LISTENER=localhost:1"]),
  };
  for (const mode of ["implementation", "repair"]) {
    const value = results.modes[mode];
    assert.equal(value.nativeTcp.stdout, "CONNECTED");
    assert.equal(value.nativeUdp.stdout, "SENT");
    assert.equal(value.nativeUnix.stdout, "CONNECTED");
    assert.match(value.descendantTcp.stdout, /CONNECTED/);
    assert.equal(value.nativeForbidden.stdout, "EPERM\nEPERM\nEPERM");
    assert.equal(value.nativeGitWrite.stdout, "EPERM");
    assert.equal(value.nativeSharedGitWrite.stdout, "EPERM");
    assert.equal(value.nativeProtectedWrite.stdout.split("\n")[0], "EPERM");
    if (mode === "repair") assert.equal(value.nativeProtectedWrite.stdout, "EPERM\nEPERM");
    assert.equal(value.claude.exitCode, 0);
    assert.equal(value.claude.providerResponse, true);
    assert.equal(value.claude.allowedWrite, true);
    assert.equal(value.claude.toolResults.at(-1)?.content, "CONNECTED");
    assert.equal(value.claude.verifyEvidence, "incomplete");
  }
  for (const socketResult of Object.values(results.strictCommand)) assert.equal(socketResult.stdout, "EPERM");
  assert.match(results.nestedpureAllow.stdout, /"status":0/);
  assert.match(results.nestedoneDeny.stdout, /"status":71/);
  assert.match(results.nestedcurrent.stdout, /"status":71/);
  await close(socket); await close(unix);
  fs.writeFileSync(log, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ evidence: keepEvidence ? log : null, summary: results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ evidence: keepEvidence ? root : null, error: error.message }));
  process.exitCode = 1;
} finally {
  if (!keepEvidence) fs.rmSync(root, { recursive: true, force: true });
}
