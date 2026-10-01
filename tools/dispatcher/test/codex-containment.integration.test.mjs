import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { workerInvocation } from "../src/worker-routing.mjs";
import { isInsideWorkerSandboxEnv, repositoryGuardPaths, auditWorkerTranscript, buildWorkerSandboxProfile, guardedInvocation } from "../src/worker-guard.mjs";
import { resolveCodexExecutable, prepareCodexContainment } from "../src/codex-containment.mjs";
import { captureVerificationEvidence } from "../src/readiness-evidence.mjs";

// Requires the installed CLI and a real, unnested Mac session. Never call a
// live provider, read a real credential, or change the daemon. The fake SSE
// provider drives the stock CLI's actual exec_command/apply_patch tools.
const available = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec") && !isInsideWorkerSandboxEnv();
describe.skipIf(!available)("Codex sibling executor containment (MOV-401)", () => {
  let root, main, own, sibling, home, credential;
  beforeAll(() => {
    resolveCodexExecutable(); // Missing installation is a failed local gate.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mov401-proof-")));
    fs.writeFileSync(path.join(root, "installation.json"), JSON.stringify({ version: execFileSync(resolveCodexExecutable(), ["--version"], { encoding: "utf8" }).trim(), date: new Date().toISOString() }));
    main = path.join(root, "main"); own = path.join(root, "own"); sibling = path.join(root, "sibling"); home = path.join(root, "fake-home");
    fs.mkdirSync(main);
    const git = (args, cwd = main) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git(["init", "-q"]); git(["config", "user.email", "fixture@example.com"]); git(["config", "user.name", "Fixture"]);
    fs.writeFileSync(path.join(main, "main.txt"), "main\n");
    git(["add", "."]); git(["commit", "-qm", "fixture"]);
    git(["worktree", "add", "-qb", "own", own]); git(["worktree", "add", "-qb", "sibling", sibling]);
    for (const dir of [".config/moviecal", ".config/gh", ".ssh", ".codex", ".claude", "Library/Keychains"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
    credential = path.join(home, ".config/moviecal/linear.env"); fs.writeFileSync(credential, "FAKE_CREDENTIAL=fixture-only\n");
    fs.writeFileSync(path.join(home, ".codex/auth.json"), "{}\n");
    fs.writeFileSync(path.join(home, ".config/moviecal/openrouter-jev.env"), "OPENROUTER_API_KEY=fake-openrouter-key\n", { mode: 0o600 });
    for (const dir of ["docs/product", "docs/operators", "src", "test", ".github/workflows"]) fs.mkdirSync(path.join(own, dir), { recursive: true });
    for (const file of ["AGENTS.md", ".github/copilot-instructions.md", "docs/product/brief.md", "test/protected.txt"]) fs.writeFileSync(path.join(own, file), "fixture guidance\n");
    fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ scripts: { verify: "node verify.cjs" } }));
    fs.writeFileSync(path.join(own, "verify.cjs"), "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/build.txt','build-ok');\n");
  });
  afterAll(() => {
    // Optional explicit proof export stays outside the repository. Defaults
    // to disposable test data; never rely on Linux skips as Mac evidence.
    if (root && process.env.MOV401_EVIDENCE_DIR) fs.cpSync(root, process.env.MOV401_EVIDENCE_DIR, { recursive: true });
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reproduces the collision using the installed Codex sandbox path", () => {
    const binary = resolveCodexExecutable();
    const args = ["sandbox", "-P", ":workspace", "-C", own, "--", "/bin/echo", "inner-ok"];
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, ".codex") };
    const direct = spawnSync(binary, args, { encoding: "utf8", env });
    expect(direct.status, direct.stderr).toBe(0);
    const profilePath = path.join(root, "legacy.sb");
    fs.writeFileSync(profilePath, buildWorkerSandboxProfile({ worktreePath: own, home }));
    const wrapped = guardedInvocation({ command: binary, args }, { profilePath });
    const nested = spawnSync(wrapped.command, wrapped.args, { encoding: "utf8", env });
    expect(nested.status).not.toBe(0);
    expect(nested.stderr).toMatch(/sandbox_apply: Operation not permitted/);
    fs.writeFileSync(path.join(root, "native-collision.json"), JSON.stringify({ direct: { exitCode: direct.status, stdout: direct.stdout }, nested: { exitCode: nested.status, stderr: nested.stderr } }));
  });

  async function fixture(mode, commands, name, modifyContainment = (value) => value, { broker = false } = {}) {
    let requests = 0;
    const unixPath = path.join(root, `${name}.sock`);
    const unixServer = broker ? net.createServer() : null;
    if (unixServer) await new Promise((resolve) => unixServer.listen(unixPath, resolve));
    const provider = http.createServer(async (req, res) => {
      if (req.method !== "POST" || !req.url.endsWith("/responses")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [], models: [] }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const command = commands[requests++]?.replaceAll?.("PROVIDER_PORT", String(provider.address().port))
        ?.replaceAll("FIXTURE_SOCKET_PATH", unixPath) ?? commands[requests - 1];
      const events = command ? [{ type: "response.output_item.done", item: typeof command === "string" ? { type: "function_call", name: "exec_command", call_id: `call-${requests}`,
        arguments: JSON.stringify({ cmd: command, workdir: own, login: false, max_output_tokens: 2000 }) }
        : { type: "custom_tool_call", name: command.code ? "exec" : "apply_patch", call_id: `call-${requests}`, input: command.code || command.patch } }]
        : [{ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture complete." }] } }];
      events.push({ type: "response.completed", response: { id: `response-${requests}`, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
      fs.appendFileSync(path.join(root, `${name}-provider.jsonl`), JSON.stringify({ request: requests,
        authenticated: req.headers.authorization === "Bearer fake-openrouter-key", model: parsed.model,
        providerPolicy: parsed.provider, toolOutputs: parsed.input?.filter((item) => ["function_call_output", "custom_tool_call_output"].includes(item.type)) }) + "\n");
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const invocation = workerInvocation("codex", "cheap");
    invocation.args.push("--skip-git-repo-check");
    if (!broker) invocation.args.push("-c", 'model_provider="fixture"', "-c",
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
    const logDir = path.join(root, name);
    const providerTransport = broker ? { enabled: true,
      credentialPath: path.join(home, ".config/moviecal/openrouter-jev.env"),
      upstream: `http://127.0.0.1:${provider.address().port}/v1/responses`,
      policy: { hash: "a".repeat(64), model: "typesafe/jev-router", providers: [],
        zdr: false, dataCollection: null, promptLogging: false, keyId: "fake-key-id", workspaceId: "fake-workspace",
        keyLimitUsd: 69, spendCeilingUsd: 75, ownerReviewed: true } } : null;
    try {
      const result = await spawnWorker({ invocation, cwd: own, logDir, brief: "Run the bounded disposable fixture only.",
        securityContext: { mode, home }, killGraceMs: 10, signal: AbortSignal.timeout(25000),
        ...(broker ? { jev: { armId: "jev-hosted", policyHash: "a".repeat(64) }, providerTransport } : {}),
        repositoryGuardPathsFn: () => repositoryGuardPaths(own, undefined, undefined, home),
        // Native installation, profiles, supervisor and process launch are real.
        prepareCodexContainmentFn: (args) => modifyContainment(prepareCodexContainment({ ...args,
          sourceEnvironment: { ...args.sourceEnvironment, HOME: home, CODEX_HOME: path.join(home, ".codex") },
          openRouterFixture: broker })),
      });
      return { result, transcript: fs.readFileSync(path.join(logDir, "stdout.log"), "utf8"), logDir, requests };
    } finally {
      await new Promise((resolve) => provider.close(resolve));
      if (unixServer) await new Promise((resolve) => unixServer.close(resolve));
    }
  }

  it("completes real Codex guidance, pwd, own build writes and verification through guarded spawn", async () => {
    const { result, transcript, logDir } = await fixture("implementation", ["cat AGENTS.md", "pwd", "echo harmless > src/fixture.txt",
      { patch: `*** Begin Patch\n*** Add File: ${own}/src/patch.txt\n+patched\n*** End Patch` }, "npm run verify"], "happy");
    expect(result.exitCode, transcript).toBe(0);
    expect(transcript).not.toContain("sandbox_apply");
    expect(transcript).toContain("fixture guidance");
    expect(fs.readFileSync(path.join(own, "src/fixture.txt"), "utf8")).toBe("harmless\n");
    expect(fs.readFileSync(path.join(own, "dist/build.txt"), "utf8")).toBe("build-ok");
    expect(fs.readFileSync(path.join(own, "src/patch.txt"), "utf8")).toBe("patched\n");
    expect(auditWorkerTranscript(transcript).ok).toBe(true);
    expect(captureVerificationEvidence(logDir).status).toBe("passed");
    expect(JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8")).securityGuard)
      .toMatchObject({ enforced: true, arrangement: "codex-sibling-exec-server" });
  }, 30000);

  it.each(["implementation", "repair"])("routes only the approved Responses call through the key-isolated broker in %s", async (mode) => {
    const probe = `const fs=require('fs'),net=require('net'),dgram=require('dgram');
if(process.env.MOVIECAL_PROVIDER_BROKER_TOKEN||process.env.OPENROUTER_API_KEY)throw Error('provider credential inherited');
const key=${JSON.stringify(path.join(home, ".config/moviecal/openrouter-jev.env"))};
try{fs.readFileSync(key);throw Error('key readable')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}
const ports=[Number(process.env.FIXTURE_PORT),1];
const tcp=ports.map(port=>new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port});s.on('connect',()=>reject(Error('TCP allowed')));s.on('error',e=>['EPERM','EACCES'].includes(e.code)?resolve():reject(e))}));
const unix=new Promise((resolve,reject)=>{const s=net.connect({path:process.env.FIXTURE_SOCKET});s.on('connect',()=>reject(Error('Unix socket allowed')));s.on('error',e=>['EPERM','EACCES'].includes(e.code)?resolve():reject(e))});
const udp=new Promise((resolve,reject)=>{const s=dgram.createSocket('udp4');let settled=false;const finish=e=>{if(settled)return;settled=true;s.close();e&&['EPERM','EACCES'].includes(e.code)?resolve():reject(e||Error('UDP allowed'))};s.on('error',finish);s.send(Buffer.from('probe'),Number(process.env.FIXTURE_PORT),'127.0.0.1',finish)});
Promise.all([...tcp,unix,udp]).then(()=>console.log('broker boundaries denied')).catch(e=>{console.error(e);process.exitCode=1});`;
    fs.writeFileSync(path.join(own, `broker-${mode}.cjs`), probe);
    const { result, transcript, logDir, requests } = await fixture(mode,
      [`FIXTURE_PORT=PROVIDER_PORT FIXTURE_SOCKET=FIXTURE_SOCKET_PATH node broker-${mode}.cjs`],
      `broker-${mode}`, (value) => value, { broker: true });
    expect(result.exitCode, transcript).toBe(0);
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(transcript).toContain("broker boundaries denied");
    const records = fs.readFileSync(path.join(root, `broker-${mode}-provider.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
    expect(records.every((record) => record.authenticated && record.model === "typesafe/jev-router"
      && record.providerPolicy === undefined)).toBe(true);
    for (const file of ["codex-launch.json", "manifest.json", "stdout.log", "stderr.log"]) {
      expect(fs.readFileSync(path.join(logDir, file), "utf8")).not.toContain("fake-openrouter-key");
    }
  }, 30000);

  it("starts no routed client when the dedicated credential is invalid", async () => {
    const key = path.join(home, ".config/moviecal/openrouter-jev.env");
    fs.writeFileSync(key, "OPENROUTER_API_KEY=invalid key with spaces\n", { mode: 0o600 });
    try {
      const { result, transcript, requests } = await fixture("implementation", ["echo should-not-run > src/escape.txt"],
        "broker-bad-key", (value) => value, { broker: true });
      expect(result.exitCode).not.toBe(0);
      expect(requests).toBe(0);
      expect(transcript).not.toContain("command_execution");
      expect(fs.existsSync(path.join(own, "src/escape.txt"))).toBe(false);
    } finally { fs.writeFileSync(key, "OPENROUTER_API_KEY=fake-openrouter-key\n", { mode: 0o600 }); }
  }, 30000);

  it.each(["missing", "invalid"])("fails closed on a %s executor profile before client or command activity", async (failure) => {
    const { result, transcript, requests } = await fixture("implementation", ["echo escaped > escape.txt"], `failure-${failure}`, (containment) => {
      if (failure === "missing") fs.unlinkSync(containment.evidence.executorProfile);
      else fs.writeFileSync(containment.evidence.executorProfile, "invalid profile");
      return containment;
    });
    expect(result.exitCode).not.toBe(0);
    expect(requests).toBe(0);
    expect(transcript).not.toContain("command_execution");
    expect(fs.existsSync(path.join(own, "escape.txt"))).toBe(false);
  }, 30000);

  it("keeps code-mode JavaScript free of OS and network APIs and delegates commands to the guarded executor", async () => {
    const code = `for(const name of ['fetch','process','require','Deno','WebSocket']){if(typeof globalThis[name]!=='undefined')throw new Error('exposed '+name)}
for(const name of ['node:fs','node:net','http://127.0.0.1/','/etc/passwd']){let denied=false;try{await import(name)}catch{denied=true}if(!denied)throw new Error('import allowed '+name)}
text('isolate APIs unavailable');text(await tools.exec_command({cmd:'echo code-mode-ok > src/code-mode.txt',workdir:${JSON.stringify(own)},login:false}));`;
    const { result, transcript, logDir } = await fixture("implementation", [{ code }, "cat src/code-mode.txt"], "code-mode");
    expect(result.exitCode, transcript).toBe(0);
    const provider = fs.readFileSync(path.join(root, "code-mode-provider.jsonl"), "utf8");
    expect(provider).toContain("isolate APIs unavailable");
    expect(fs.readFileSync(path.join(own, "src/code-mode.txt"), "utf8")).toBe("code-mode-ok\n");
    const launch = JSON.parse(fs.readFileSync(path.join(logDir, "codex-launch.json"), "utf8"));
    // The client guard also refuses a shell even when launched directly.
    const shell = guardedInvocation({ command: "/bin/sh", args: ["-c", "echo escaped"] }, { profilePath: launch.harnessProfile });
    expect(spawnSync(shell.command, shell.args, { encoding: "utf8" }).status).not.toBe(0);
  }, 30000);

  it.each(["implementation", "repair"])("enforces filesystem, executable, credential and tool-network denials in %s", async (mode) => {
    const protectedTargets = [path.join(root, "unrelated.txt"), path.join(main, "main.txt"), path.join(sibling, "sibling.txt"),
      path.join(main, ".git/HEAD"), path.join(own, "AGENTS.md"), path.join(own, ".github/workflows/evil.yml")];
    if (mode === "repair") protectedTargets.push(path.join(own, "test/protected.txt"), path.join(own, "package.json"), path.join(own, "docs/operators/evil.md"));
    const script = `const fs=require('fs'), cp=require('child_process'), net=require('net');
const targets=${JSON.stringify(protectedTargets)};
for(const target of targets){try{fs.writeFileSync(target,'escape');throw new Error('ALLOWED WRITE '+target)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}
for(const target of ${JSON.stringify([credential, path.join(home, ".codex/auth.json")])}){try{fs.readFileSync(target);throw new Error('ALLOWED READ '+target)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}
for(const binary of ['/usr/bin/git','/usr/bin/curl','/usr/bin/ssh','/usr/bin/security']){const r=cp.spawnSync(binary,['--help']);if(!r.error||!['EPERM','EACCES'].includes(r.error.code))throw new Error('ALLOWED EXEC '+binary)}
try{fs.renameSync('.github','src/moved-governance');throw new Error('ALLOWED ANCESTOR MOVE')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}
for(const host of ['127.0.0.1','::1']){const server=net.createServer();server.on('listening',()=>{console.error('ALLOWED LISTENER');process.exit(1)});server.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('listener denied')});server.listen(0,host)}
const udp=require('dgram').createSocket('udp4');udp.on('listening',()=>{console.error('ALLOWED UDP');process.exit(1)});udp.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;udp.close();console.log('UDP denied')});udp.bind(0,'127.0.0.1');
const socket=net.connect({host:'127.0.0.1',port:PORT});socket.on('connect',()=>{console.error('ALLOWED NETWORK');process.exit(1)});socket.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('all boundaries denied')});setTimeout(()=>{console.error('network probe timeout');process.exit(1)},2000).unref();`;
    // A listening negative control proves denial is policy, not ECONNREFUSED.
    const listener = http.createServer((_req, res) => res.end("should not be reached"));
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    fs.writeFileSync(path.join(own, `probe-${mode}.cjs`), script.replace("PORT", String(listener.address().port)));
    try {
      const { result, transcript } = await fixture(mode, [`node probe-${mode}.cjs`, `echo allowed > src/${mode}.txt`], mode);
      expect(result.exitCode, transcript).toBe(0);
      expect(transcript).toContain("all boundaries denied");
      expect(transcript).not.toContain("sandbox_apply");
      expect(fs.readFileSync(path.join(own, `src/${mode}.txt`), "utf8")).toBe("allowed\n");
    } finally { await new Promise((resolve) => listener.close(resolve)); }
  }, 30000);
});
