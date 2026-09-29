#!/usr/bin/env node
// MOV-416: explicit human-led full-repository verification. The installed
// Codex CLI and native executor are real; a local deterministic SSE provider
// supplies only bounded commands, with no account credential or model traffic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureWorktreeDependencies, writeDependencyInstallRecord } from "../src/dependency-install.mjs";
import { spawnWorker } from "../src/worker-spawn.mjs";
import { workerInvocation } from "../src/worker-routing.mjs";
import { prepareCodexContainment, resolveCodexExecutable } from "../src/codex-containment.mjs";
import { auditWorkerResult, isInsideWorkerSandboxEnv, repositoryGuardPaths, writeWorkerAudit } from "../src/worker-guard.mjs";
import { captureVerificationEvidence } from "../src/readiness-evidence.mjs";

const evidenceRoot = process.argv[2];
if (process.platform !== "darwin" || isInsideWorkerSandboxEnv() || !evidenceRoot || !path.isAbsolute(evidenceRoot)) {
  throw new Error("Run outside a worker sandbox on macOS: node tools/dispatcher/bin/codex-repository-verify-smoke.mjs /absolute/new/evidence-directory");
}
if (fs.existsSync(evidenceRoot)) throw new Error(`evidence directory already exists: ${evidenceRoot}`);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const branch = git(["branch", "--show-current"]);
const head = git(["rev-parse", "HEAD"]);
if (!branch.startsWith("agent/MOV-416-") || git(["status", "--porcelain=v1"])) {
  throw new Error("run from the clean, committed MOV-416 issue branch");
}
resolveCodexExecutable();
fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const checkout = path.join(evidenceRoot, "checkout");
const logDir = path.join(evidenceRoot, "run");
const home = path.join(evidenceRoot, "empty-home");
execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--single-branch", "--branch", branch, repo, checkout], { stdio: "ignore" });
if (git(["rev-parse", "HEAD"], checkout) !== head) throw new Error("fixture clone did not capture the issue head");
fs.mkdirSync(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}\n", { mode: 0o600 });

const dependencyInstall = await ensureWorktreeDependencies({ worktreePath: checkout, logDir });
writeDependencyInstallRecord(logDir, dependencyInstall);
const initial = { issue: "MOV-416", head, branch, installedCli: execFileSync(resolveCodexExecutable(), ["--version"], { encoding: "utf8" }).trim(), dependencyInstall: { ok: dependencyInstall?.ok, status: dependencyInstall?.status, reason: dependencyInstall?.reason || null } };
if (!dependencyInstall?.ok) {
  fs.writeFileSync(path.join(evidenceRoot, "proof.json"), JSON.stringify({ ...initial, passed: false, reason: "trusted dependency install failed; no worker started" }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: false, evidenceRoot, reason: "trusted dependency install failed" }) + "\n");
  process.exitCode = 1;
} else {
  const commands = ["echo fixture-ok > mov-416-marker.txt", "npm run verify"];
  let requestCount = 0;
  let commandIndex = 0;
  const provider = http.createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], models: [] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const lastOutput = parsed.input?.filter((item) => item.type === "function_call_output").at(-1)?.output || "";
    const session = /Process running with session ID\s+(\d+)/i.exec(String(lastOutput));
    const next = session ? { name: "write_stdin", args: { session_id: Number(session[1]), chars: "", yield_time_ms: 1000, max_output_tokens: 2500 } }
      : commandIndex < commands.length ? { name: "exec_command", args: { cmd: commands[commandIndex++], workdir: checkout, login: false, yield_time_ms: 1000, max_output_tokens: 2500 } }
        : null;
    requestCount++;
    const events = [next
      ? { type: "response.output_item.done", item: { type: "function_call", name: next.name, call_id: `fixture-${requestCount}`, arguments: JSON.stringify(next.args) } }
      : { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture complete." }] } },
    { type: "response.completed", response: { id: `fixture-response-${requestCount}`, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const invocation = workerInvocation("codex", "cheap");
  invocation.args.push("--skip-git-repo-check", "-c", 'model_provider="fixture"', "-c",
    `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
  let result;
  try {
    result = await spawnWorker({ invocation, cwd: checkout, logDir,
      brief: "This is a disposable MOV-416 verification fixture. The trusted installer already prepared dependencies. Do not install anything, use Git/GitHub, browse, delegate, or change existing source. Write only mov-416-marker.txt containing fixture-ok; then run literal npm run verify synchronously and wait for its final result. Report that result and stop.",
      securityContext: { mode: "implementation", home }, signal: AbortSignal.timeout(480000),
      repositoryGuardPathsFn: () => repositoryGuardPaths(checkout, undefined, undefined, home),
      prepareCodexContainmentFn: (args) => prepareCodexContainment({ ...args,
        sourceEnvironment: { ...args.sourceEnvironment, HOME: home, CODEX_HOME: path.join(home, ".codex") } }),
    });
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
  const audit = auditWorkerResult({ worktreePath: checkout, branch, logDir, baseRef: head });
  const auditRecord = writeWorkerAudit(logDir, { issue: "MOV-416", worker: "codex", exitCode: result.exitCode, ...audit });
  const verification = captureVerificationEvidence(logDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(logDir, "manifest.json"), "utf8"));
  const markerPath = path.join(checkout, "mov-416-marker.txt");
  const marker = fs.existsSync(markerPath) && fs.readFileSync(markerPath, "utf8").trim() === "fixture-ok";
  const noWorkerInstall = !audit.actions.some((action) => /\bnpm\s+(ci|install)\b/.test(JSON.stringify(action)));
  const passed = result.exitCode === 0 && audit.ok && verification.status === "passed" && marker && noWorkerInstall
    && dependencyInstall.ok === true && manifest.securityGuard?.arrangement === "codex-sibling-exec-server";
  const proof = { ...initial, passed, workerExitCode: result.exitCode, auditOk: audit.ok, auditSha256: auditRecord.sha256,
    violations: audit.violations, verificationStatus: verification.status, verifyExecutions: verification.executions.length,
    marker, noWorkerInstall, guard: manifest.securityGuard, evidenceRoot, requestCount };
  fs.writeFileSync(path.join(evidenceRoot, "proof.json"), JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed, head, evidenceRoot, verification: verification.status, auditOk: audit.ok }) + "\n");
  process.exitCode = passed ? 0 : 1;
}
