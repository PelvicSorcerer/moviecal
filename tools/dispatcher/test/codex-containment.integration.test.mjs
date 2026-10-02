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
import { PROOF_VERIFIER } from "../src/openrouter-proof.mjs";
import { JevCohortStore, policyDigest, resolveCohortTransport } from "../src/jev-cohort.mjs";

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

  async function fixture(mode, commands, name, modifyContainment = (value) => value, { broker = false, failure = null, proofDebug = false, control = false, production = false } = {}) {
    let requests = 0;
    let cohortStore = null;
    const unixPath = path.join(root, `${name.slice(-12)}.sock`);
    const unixServer = broker ? net.createServer() : null;
    if (unixServer) await new Promise((resolve, reject) => {
      unixServer.once("error", reject); unixServer.listen(unixPath, resolve);
    });
    const provider = http.createServer(async (req, res) => {
      if ((control || production) && req.url === "/api/v1/key") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { limit: 69, usage: 1, limit_remaining: 68 } })); return;
      }
      if ((control || production) && req.url === "/api/v1/credits") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { total_credits: 10.5, total_usage: 10 } })); return;
      }
      if (req.method !== "POST" || !req.url.endsWith("/responses")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [], models: [] }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (control && Object.hasOwn(parsed, "parallel_tool_calls")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unsupported_parameters", message: "private-parameter-detail" } })); return;
      }
      if (failure === "outage") { requests++; res.writeHead(503); res.end('private-error-sentinel'); return; }
      if (failure === "parameter-404") { requests++; res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unsupported_parameters", message: "private-parameter-detail" } })); return; }
      if (failure === "timeout") { requests++; return; }
      let command = commands[requests++]?.replaceAll?.("PROVIDER_PORT", String(provider.address().port))
        ?.replaceAll("FIXTURE_SOCKET_PATH", unixPath) ?? commands[requests - 1];
      // Unknown router slugs use Codex's fallback tool set: shell patches,
      // not the native custom apply_patch tool offered by known Codex models.
      if (broker && command?.patch) command = `apply_patch <<'PATCH'\n${command.patch}\nPATCH`;
      const events = command ? [{ type: "response.output_item.done", item: typeof command === "string" ? { type: "function_call", name: "exec_command", call_id: `call-${requests}`,
        arguments: JSON.stringify({ cmd: command, workdir: own, login: false, max_output_tokens: 2000 }) }
        : { type: "custom_tool_call", name: command.code ? "exec" : "apply_patch", call_id: `call-${requests}`, input: command.code || command.patch } }]
        : [{ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture complete." }] } }];
      events.push({ type: "response.completed", response: { id: `response-${requests}`, output: [],
        ...(broker ? { model: control ? "openai/fixture" : "google/fixture", reasoning: { effort: "low" },
          openrouter_metadata: { attempt: 1, pipeline: control ? [] : [{ name: "jev-router", data: { resolved_models: ["google/fixture"], candidates: [{ model: "google/fixture", effort: "low" }] } }], endpoints: { available: [{ selected: true, provider: control ? "OpenAI" : "Google", model: control ? "openai/fixture-20260929" : "google/fixture-20260929" }] } } } : {}),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
          ...(broker ? { cost: failure === "excess-invoice" ? 70 : 0.001, input_tokens_details: { cached_tokens: 0 } } : {}) } } });
      if (failure === "missing-metadata") delete events.at(-1).response.openrouter_metadata;
      if (proofDebug) {
        const response = events.at(-1).response;
        response.openrouter_metadata.pipeline = [{ name: "jev-router", data: {
          candidates: [{ model: "openai/fixture", effort: "medium", prompt: "private-debug-prompt-sentinel" }] } }];
        response.model = "openai/fixture";
        response.openrouter_metadata.endpoints.available = [{ selected: true, provider: "Azure", model: "openai/fixture-20260929" }];
        events.unshift({ type: "response.debug", sequence_number: 0, debug: { echo_upstream_body: {
          model: "fixture", reasoning: { effort: "medium" }, messages: [{ content: "private-debug-prompt-sentinel" }],
          tools: [{ description: "private-debug-tool-sentinel" }] } } });
      }
      if (failure === "refusal") events.unshift({ type: "response.refusal.done", refusal: "private-refusal-sentinel" });
      if (failure === "malformed-tool") events.unshift({ type: "response.output_item.done", item: {
        type: "function_call", name: "exec_command", call_id: "bad-call", arguments: "not-json" } });
      if (failure === "unsupported-tool") events.unshift({ type: "response.output_item.done", item: {
        type: "custom_tool_call", name: "apply_patch", call_id: "bad-call", input: "private-unsupported-tool-sentinel" } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (proofDebug) await new Promise((resolve) => setTimeout(resolve, 100));
      res.end();
      if (failure === "stop-after-first" && requests === 1) cohortStore.stop("fixture-operator-stop");
      if (failure === "approval-after-first" && requests === 1) {
        const approval = JSON.parse(fs.readFileSync(cohortStore.approvalPath, "utf8"));
        fs.writeFileSync(cohortStore.approvalPath, JSON.stringify({ ...approval, ownerApproved: false }));
      }
      fs.appendFileSync(path.join(root, `${name}-provider.jsonl`), JSON.stringify({ request: requests,
        authenticated: req.headers.authorization === "Bearer fake-openrouter-key", model: parsed.model,
        providerPolicy: parsed.provider, debugRequested: parsed.debug?.echo_upstream_body === true,
        parallelPresent: Object.hasOwn(parsed, "parallel_tool_calls"), requestedEffort: parsed.reasoning?.effort,
        tools: parsed.tools?.map((tool) => tool.name || tool.function?.name),
        toolOutputs: parsed.input?.filter((item) => ["function_call_output", "custom_tool_call_output"].includes(item.type)) }) + "\n");
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const invocation = workerInvocation("codex", "cheap");
    invocation.args.push("--skip-git-repo-check");
    if (!broker) invocation.args.push("-c", 'model_provider="fixture"', "-c",
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
    const logDir = path.join(root, name);
    let providerTransport = broker ? { enabled: true,
      credentialPath: path.join(home, ".config/moviecal/openrouter-jev.env"),
      upstream: `http://127.0.0.1:${provider.address().port}/v1/responses`,
      policy: { hash: "a".repeat(64), model: "typesafe/jev-router", providers: [],
        zdr: false, dataCollection: null, promptLogging: false, keyId: "fake-key-id", workspaceId: "fake-workspace",
        keyLimitUsd: 69, spendCeilingUsd: 75, ownerReviewed: true } } : null;
    let jev = broker ? { armId: "jev-hosted", policyHash: "a".repeat(64) } : null;
    if (control || production) {
      // A relocated dispatcher store must stay unreadable to commands, while
      // the dedicated credential still belongs to the actual fake home.
      const storeDir = path.join(root, `external-state-${name}`);
      fs.mkdirSync(storeDir, { mode: 0o700 });
      const configPath = path.join(storeDir, `jev-cohort-${name}.json`);
      const approvalPath = path.join(storeDir, `jev-cohort-${name}-approval.json`);
      const ledgerPath = path.join(storeDir, `jev-cohort-${name}-ledger.json`);
      const now = new Date(), expiresAt = new Date(now.getTime() + 86400000).toISOString();
      const policy = { trialId: name, route: "codex-openrouter-responses", activatedAt: now.toISOString(), expiresAt,
        pairs: [{ routed: "MOV-10", control: "MOV-11" }], routed: { model: "typesafe/jev-router", worker: "codex", tier: "cheap" },
        control: { model: "openai/fixture", worker: "codex", provider: "OpenAI", providerSlug: "openai", effort: "low", tier: "cheap" },
        keyId: "fake-key-id", workspaceId: "fake-workspace", keyLimitUsd: 69, allInCeilingUsd: 75,
        priorOutlayUsd: 0, baselineKeyUsageUsd: 1, purchaseFeesUsd: 0,
        modelAliases: { "openai/fixture": "openai/fixture-20260929", "google/fixture": "google/fixture-20260929" } };
      fs.writeFileSync(configPath, JSON.stringify({ enabled: false, policy }), { mode: 0o600 });
      fs.writeFileSync(approvalPath, JSON.stringify({ issue: "MOV-431", owner: "Adam Moore", ownerApproved: true,
        securityReviewPassed: true, accountPolicyReviewed: true, effectiveEligibilityUnrestricted: true,
        promptLoggingOff: true, zdrOff: true, dataCollectionUnrestricted: true, priorOutlayBasisReviewed: true,
        existingCreditOnlyReviewed: true, hardKeyCapReviewed: true, dedicatedKeyExclusiveReviewed: true,
        paymentBound: "dedicated-key-total-limit",
        keyLimitUsd: 69, allInCeilingUsd: 75, keyId: policy.keyId, workspaceId: policy.workspaceId,
        policySha256: policyDigest(policy), reviewedAt: now.toISOString(), expiresAt,
        availableCreditUsd: 0.5, totalCreditsUsd: 10.5, totalUsageUsd: 10, keyRemainingUsd: 68 }), { mode: 0o600 });
      const store = new JevCohortStore({ home, storeRoot: storeDir, configPath, approvalPath, ledgerPath });
      cohortStore = store;
      store.activate(now);
      const assignment = store.admit({ identifier: control ? "MOV-11" : "MOV-10", labels: control ? ["worker:codex"] : ["worker:codex", "router:jev"] },
        { worker: "codex", tier: "cheap", effort: "low", now }).record;
      providerTransport = resolveCohortTransport(store, assignment, { home });
      providerTransport.upstream = `http://127.0.0.1:${provider.address().port}/v1/responses`;
      jev = { armId: assignment.armId, policyHash: assignment.policyHash, side: assignment.side };
    }
    try {
      const result = await spawnWorker({ invocation, cwd: own, logDir, brief: "Run the bounded disposable fixture only.",
        securityContext: { mode, home }, killGraceMs: 10, signal: AbortSignal.timeout(25000),
        ...(broker ? { jev, providerTransport } : {}),
        repositoryGuardPathsFn: () => repositoryGuardPaths(own, undefined, undefined, home),
        // Native installation, profiles, supervisor and process launch are real.
        prepareCodexContainmentFn: (args) => modifyContainment(prepareCodexContainment({ ...args,
          sourceEnvironment: { ...args.sourceEnvironment, HOME: home, CODEX_HOME: path.join(home, ".codex") },
          openRouterFixture: broker, openRouterModelAliases: { "google/fixture": "google/fixture-20260929", "openai/fixture": "openai/fixture-20260929" },
          openRouterProofDebug: proofDebug, providerRequestLimit: broker ? 6 : null })),
      });
      return { result, transcript: fs.readFileSync(path.join(logDir, "stdout.log"), "utf8"), logDir, requests,
        cohortEvidence: cohortStore?.export() };
    } finally {
      await new Promise((resolve) => provider.close(resolve));
      if (unixServer) await new Promise((resolve) => unixServer.close(resolve));
    }
  }

  it.each([true, false])("completes real read/edit/verify with debug=%s and private payloads redacted", async (proofDebug) => {
    fs.writeFileSync(path.join(own, "answer.txt"), "before\n");
    const originalVerifier = fs.readFileSync(path.join(own, "verify.cjs"), "utf8");
    fs.writeFileSync(path.join(own, "verify.cjs"), PROOF_VERIFIER);
    const { result, logDir, transcript, requests } = await fixture("implementation",
      ["cat answer.txt", { patch: `*** Begin Patch\n*** Update File: ${own}/answer.txt\n@@\n-before\n+after\n*** End Patch` }, "npm run verify"],
      proofDebug ? "proof-debug" : "proof-normal", (value) => value, { broker: true, proofDebug });
    fs.writeFileSync(path.join(own, "verify.cjs"), originalVerifier);
    expect(result.exitCode, transcript).toBe(0); expect(requests).toBe(4);
    expect(captureVerificationEvidence(logDir).status).toBe("passed");
    expect(fs.readFileSync(path.join(own, "answer.txt"), "utf8")).toBe("after\n");
    expect(transcript.split("\n").filter(Boolean).map(JSON.parse).some((event) => event.type === "item.completed"
      && event.item?.type === "file_change" && event.item.status === "completed")).toBe(true);
    const records = fs.readFileSync(path.join(logDir, "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(records.every((row) => row.resolvedEffort === (proofDebug ? "medium" : "low") && row.provider === (proofDebug ? "Azure" : "Google") && row.error === null)).toBe(true);
    const attribution = fs.readFileSync(path.join(logDir, "openrouter-attribution.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(attribution.every((row) => row.resolvedEffortSource === (proofDebug ? "upstream-request" : "response-and-jev-selection") && row.debugCount === (proofDebug ? 1 : 0))).toBe(true);
    expect(attribution.every((row) => row.responseEffort === "low")).toBe(true);
    const provider = fs.readFileSync(path.join(root, `${proofDebug ? "proof-debug" : "proof-normal"}-provider.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
    expect(provider.every((row) => row.debugRequested === proofDebug)).toBe(true);
    for (const file of fs.readdirSync(logDir).filter((name) => /\.(json|jsonl|log)$/.test(name))) {
      expect(fs.readFileSync(path.join(logDir, file), "utf8")).not.toMatch(/private-debug-(prompt|tool)-sentinel/);
    }
  }, 30000);

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
      ["cat AGENTS.md", `FIXTURE_PORT=PROVIDER_PORT FIXTURE_SOCKET=FIXTURE_SOCKET_PATH node broker-${mode}.cjs`,
        ...(mode === "implementation" ? [{ patch: `*** Begin Patch\n*** Add File: ${own}/src/jev.txt\n+jev-proof\n*** End Patch` }, "npm run verify"] : [])],
      `broker-${mode}`, (value) => value, { broker: true });
    expect(result.exitCode, transcript).toBe(0);
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(transcript).toContain("broker boundaries denied");
    const accounting = fs.readFileSync(path.join(logDir, "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(accounting).toHaveLength(requests);
    expect(accounting.every((row) => row.resolvedModel === "google/fixture" && row.provider === "Google"
      && row.resolvedEffort === "low" && row.billedUsd === 0.001 && row.error === null)).toBe(true);
    const attribution = fs.readFileSync(path.join(logDir, "openrouter-attribution.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(attribution).toHaveLength(requests);
    expect(attribution.every((row) => row.canonicalModel === "google/fixture-20260929"
      && row.resolvedEffortSource === "response-and-jev-selection" && row.routerStageKeys.join() === "resolved_models,candidates")).toBe(true);
    if (mode === "implementation") expect(captureVerificationEvidence(logDir).status).toBe("passed");
    const records = fs.readFileSync(path.join(root, `broker-${mode}-provider.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
    expect(records.every((record) => record.authenticated && record.model === "typesafe/jev-router"
      && record.providerPolicy === undefined)).toBe(true);
    for (const file of ["codex-launch.json", "manifest.json", "stdout.log", "stderr.log"]) {
      expect(fs.readFileSync(path.join(logDir, file), "utf8")).not.toContain("fake-openrouter-key");
    }
  }, 30000);

  it("runs a fixed API control through real contained Codex read/edit/exact verify with invoices", async () => {
    fs.writeFileSync(path.join(own, "answer.txt"), "before\n");
    const originalVerifier = fs.readFileSync(path.join(own, "verify.cjs"), "utf8");
    fs.writeFileSync(path.join(own, "verify.cjs"), PROOF_VERIFIER);
    try {
      const { result, transcript, logDir, requests } = await fixture("implementation",
        ["cat answer.txt", { patch: `*** Begin Patch\n*** Update File: ${own}/answer.txt\n@@\n-before\n+after\n*** End Patch` }, "npm run verify"],
        "fixed-control", (value) => value, { broker: true, control: true });
      expect(result.exitCode, transcript).toBe(0);
      expect(requests).toBe(4);
      expect(captureVerificationEvidence(logDir).status).toBe("passed");
      expect(fs.readFileSync(path.join(own, "answer.txt"), "utf8")).toBe("after\n");
      const rows = fs.readFileSync(path.join(logDir, "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      expect(rows.every((row) => row.routerArm === "fixed-control" && row.resolvedModel === "openai/fixture"
        && row.provider === "OpenAI" && row.resolvedEffort === "low" && row.billedUsd === 0.001 && row.error === null)).toBe(true);
      const providerRows = fs.readFileSync(path.join(root, "fixed-control-provider.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      expect(providerRows.every((row) => JSON.stringify(row.providerPolicy)
        === JSON.stringify({ only: ["openai"], allow_fallbacks: false, require_parameters: true }))).toBe(true);
      expect(providerRows.every((row) => !row.parallelPresent && row.requestedEffort === "low"
        && row.tools?.includes("exec_command"))).toBe(true);
      const launch = JSON.parse(fs.readFileSync(path.join(logDir, "codex-launch.json"), "utf8"));
      expect(launch.args).toContain("features.multi_agent=false");
    } finally { fs.writeFileSync(path.join(own, "verify.cjs"), originalVerifier); }
  }, 30000);

  it.each(["implementation", "repair"])("uses the production Jev cohort and denies its relocated state in %s", async (mode) => {
    const name = `production-cohort-${mode}`;
    const storePath = path.join(root, `external-state-${name}`, `jev-cohort-${name}.json`);
    const probe = `node -e 'try{require("fs").readFileSync(${JSON.stringify(storePath)});process.exit(1)}catch(e){if(!["EPERM","EACCES"].includes(e.code))throw e;console.log("cohort state denied")}'`;
    const { result, transcript, requests, cohortEvidence } = await fixture(mode,
      ["cat AGENTS.md", probe,
        ...(mode === "implementation" ? [{ patch: `*** Begin Patch\n*** Add File: ${own}/src/cohort-proof.txt\n+cohort proof\n*** End Patch` }, "npm run verify"] : [])],
      name, (value) => value, { broker: true, production: true });
    expect(result.exitCode, transcript).toBe(0);
    expect(transcript).toContain("cohort state denied");
    expect(cohortEvidence.requests).toHaveLength(requests);
    expect(cohortEvidence.requests.every((row) => row.status === "complete" && row.model === "google/fixture")).toBe(true);
  }, 30000);

  it.each(["stop-after-first", "approval-after-first", "excess-invoice"])("stops further cohort payment and fails visibly on %s", async (failure) => {
    const { result, transcript, requests, cohortEvidence } = await fixture("implementation",
      ["cat AGENTS.md", "echo should-not-run"], `cohort-${failure}`, (value) => value,
      { broker: true, control: true, failure });
    expect(result.exitCode, transcript).not.toBe(0);
    expect(requests).toBe(1);
    expect(transcript).not.toContain('"aggregated_output":"should-not-run');
    expect(cohortEvidence.stoppedReason).toBeTruthy();
    if (failure === "excess-invoice") expect(cohortEvidence.requests[0].status).toBe("pending");
    else expect(cohortEvidence.requests[0]).toMatchObject({ status: "complete", amountUsd: 0.001 });
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

  it.each(["outage", "parameter-404", "timeout", "refusal", "malformed-tool", "missing-metadata", "unsupported-tool"])("stops the real routed Codex client on %s without fallback", async (failure) => {
    const { result, logDir, requests } = await fixture("implementation", [], `route-${failure}`,
      (value) => value, { broker: true, failure });
    expect(result.exitCode).not.toBe(0);
    expect(requests).toBe(1);
    const records = fs.readFileSync(path.join(logDir, "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(records).toHaveLength(1);
    expect(records[0].error).toBeTruthy();
    if (failure === "parameter-404") expect(records[0].error).toBe("provider-http-404-unsupported_parameters");
    expect(JSON.stringify(records)).not.toContain("private-");
    expect(fs.readFileSync(path.join(logDir, "stderr.log"), "utf8")).toContain("Jev route stopped:");
  }, 30000);

  it("enforces a one-request proof cap before a second upstream call", async () => {
    const { result, logDir, requests } = await fixture("implementation", ["cat AGENTS.md"], "request-cap", (containment) => {
      const launch = JSON.parse(fs.readFileSync(containment.invocation.args[1], "utf8"));
      const config = JSON.parse(fs.readFileSync(launch.brokerConfig, "utf8"));
      config.maxRequests = 1; fs.writeFileSync(launch.brokerConfig, JSON.stringify(config));
      return containment;
    }, { broker: true });
    expect(result.exitCode).not.toBe(0); expect(requests).toBe(1);
    const records = fs.readFileSync(path.join(logDir, "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(records.at(-1).error).toBe("request-cap");
  }, 30000);

  it("fails if the request cap prevents the final report after read, edit and exact verify", async () => {
    fs.writeFileSync(path.join(own, "answer.txt"), "before\n");
    const { result, requests } = await fixture("implementation",
      ["cat answer.txt", { patch: `*** Begin Patch\n*** Update File: ${own}/answer.txt\n@@\n-before\n+after\n*** End Patch` }, "npm run verify"],
      "report-cap", (containment) => {
        const launch = JSON.parse(fs.readFileSync(containment.invocation.args[1], "utf8"));
        const config = JSON.parse(fs.readFileSync(launch.brokerConfig, "utf8"));
        config.maxRequests = 3; fs.writeFileSync(launch.brokerConfig, JSON.stringify(config));
        return containment;
      }, { broker: true });
    expect(result.exitCode).not.toBe(0);
    expect(requests).toBe(3);
  }, 30000);

  it("does not carry a previous attempt's failure into a separately authorized retry", async () => {
    const first = await fixture("implementation", [], "retry-evidence", (value) => value,
      { broker: true, failure: "missing-metadata" });
    expect(first.result.exitCode).not.toBe(0);
    const second = await fixture("implementation", ["cat AGENTS.md"], "retry-evidence", (value) => value, { broker: true });
    expect(second.result.exitCode).toBe(0);
    const records = fs.readFileSync(path.join(second.logDir, "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(new Set(records.map((row) => row.attemptId)).size).toBe(2);
    expect(records[0].error).toBeTruthy(); expect(records.at(-1).error).toBeNull();
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
