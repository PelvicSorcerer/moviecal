import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { JevCohortStore, policyDigest, resolveCohortTransport } from "../src/jev-cohort.mjs";
import { isInsideWorkerSandboxEnv } from "../src/worker-guard.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

// One broker per issue attempt, as in production; the cohort store is shared.
async function harness(respond) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mov482-broker-"));
  const dir = path.join(home, ".config", "moviecal");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date(), later = new Date(now.getTime() + 86400000).toISOString();
  const policy = { trialId: "fake-4xx", route: "codex-openrouter-responses", activatedAt: now.toISOString(), expiresAt: later,
    pairs: [{ routed: "MOV-10", control: "MOV-11" }, { routed: "MOV-12", control: "MOV-13" }],
    routed: { model: "typesafe/jev-router", worker: "codex", tier: "default" },
    control: { model: "openai/fixture", worker: "codex", provider: "OpenAI", providerSlug: "openai", effort: "medium", tier: "default" },
    keyId: "fake_key", workspaceId: "fake_workspace", keyLimitUsd: 69, allInCeilingUsd: 75,
    priorOutlayUsd: 5, baselineKeyUsageUsd: 1, purchaseFeesUsd: 0, modelAliases: { "openai/fixture": "openai/fixture" } };
  const configPath = path.join(dir, "jev-cohort.json"), approvalPath = path.join(dir, "jev-cohort-approval.json"), ledgerPath = path.join(dir, "jev-cohort-ledger.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: false, policy }), { mode: 0o600 });
  fs.writeFileSync(approvalPath, JSON.stringify({ issue: "MOV-431", owner: "Adam Moore", ownerApproved: true,
    securityReviewPassed: true, accountPolicyReviewed: true, effectiveEligibilityUnrestricted: true,
    promptLoggingOff: true, zdrOff: true, dataCollectionUnrestricted: true, priorOutlayBasisReviewed: true,
    existingCreditOnlyReviewed: true, hardKeyCapReviewed: true, dedicatedKeyExclusiveReviewed: true,
    paymentBound: "dedicated-key-total-limit", keyLimitUsd: 69, allInCeilingUsd: 75, keyId: policy.keyId,
    workspaceId: policy.workspaceId, policySha256: policyDigest(policy), reviewedAt: now.toISOString(), expiresAt: later,
    availableCreditUsd: 0.5, totalCreditsUsd: 10.5, totalUsageUsd: 10, keyRemainingUsd: 68 }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "openrouter-jev.env"), "OPENROUTER_API_KEY=fake-openrouter-key\n", { mode: 0o600 });
  const store = new JevCohortStore({ home, configPath, approvalPath, ledgerPath });
  store.activate(now);
  // `account` is what the fake /key and /credits endpoints report.
  const account = { usage: 1, totalUsage: 10 };
  const provider = http.createServer(async (req, res) => {
    if (req.url === "/api/v1/key") { res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { limit: 69, usage: account.usage, limit_remaining: 69 - account.usage } })); return; }
    if (req.url === "/api/v1/credits") { res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { total_credits: 10.5, total_usage: account.totalUsage } })); return; }
    for await (const chunk of req); // drain
    respond(res, account);
  });
  await listen(provider);
  let n = 0;
  const attempt = async (issue) => {
    const record = store.admit({ identifier: issue, labels: ["worker:codex"] }, { worker: "codex", tier: "default", effort: "medium", now }).record;
    const logDir = path.join(home, `logs-${++n}`); fs.mkdirSync(logDir);
    const holder = http.createServer(); await listen(holder);
    const port = holder.address().port; await close(holder);
    const transport = resolveCohortTransport(store, record, { home });
    transport.upstream = `http://127.0.0.1:${provider.address().port}/v1/responses`;
    const brokerConfig = path.join(logDir, "openrouter-broker.json");
    fs.writeFileSync(brokerConfig, JSON.stringify({ ...transport, fixture: true, accounting: { issue, attemptId: `attempt-${n}` },
      modelAliases: policy.modelAliases, maxRequests: null, proofDebug: false }), { mode: 0o600 });
    const child = spawn(process.execPath, [path.resolve("tools/dispatcher/src/openrouter-broker.mjs"), brokerConfig],
      { env: { ...process.env, MOVIECAL_PROVIDER_BROKER_PORT: String(port), MOVIECAL_PROVIDER_BROKER_TOKEN: "fixture-broker-token" }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready\n")) resolve(); });
      child.once("exit", () => reject(new Error("broker exited before readiness")));
      setTimeout(() => reject(new Error("broker readiness timeout")), 5000);
    });
    const request = async () => { const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST",
      headers: { authorization: "Bearer fixture-broker-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/fixture", reasoning: { effort: "medium" }, input: "fake only", stream: true }) });
      const status = r.status; await r.text(); return status; };
    const evidence = () => fs.readFileSync(path.join(logDir, "openrouter-attribution.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const routing = () => fs.readFileSync(path.join(logDir, "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    return { request, evidence, routing, stop: () => child.kill("SIGTERM") };
  };
  return { store, account, attempt, cleanup: async () => { await close(provider); fs.rmSync(home, { recursive: true, force: true }); } };
}

const ok = (res) => { res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `invoice-${Math.random().toString(36).slice(2)}`,
    model: "openai/fixture", reasoning: { effort: "medium" }, status: "completed",
    usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, cost: 0.2 },
    openrouter_metadata: { attempt: 1, pipeline: [], endpoints: { available: [{ selected: true, provider: "OpenAI", model: "openai/fixture" }] } } } })}\n\n`); };

describe.skipIf(isInsideWorkerSandboxEnv())("provider non-2xx policy", () => {
  it("fails only the affected attempt on a numeric-code 400, counts billed usage, and keeps the cohort running", async () => {
    let calls = 0;
    const h = await harness((res, account) => {
      calls++;
      if (calls === 1) { account.usage += 0.05; account.totalUsage += 0.05;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 400, type: "invalid_request_error", message: "private-prompt-sentinel: tool schema rejected",
          metadata: { provider_name: "Amazon Bedrock", raw: "private-raw-sentinel" } } })); return; }
      account.usage += 0.2; account.totalUsage += 0.2; ok(res);
    });
    const first = await h.attempt("MOV-11");
    try {
      expect(await first.request()).toBe(502);
      expect(h.store.state()).toMatchObject({ status: "active", pending: 0, stoppedReason: null });
      expect(h.store.state().spentUsd).toBeCloseTo(5.05, 6);
      expect(h.store.export().requests[0]).toMatchObject({ status: "failed", reason: "provider-http-400-400" });
      expect(first.routing()[0].error).toBe("provider-http-400-400");
      expect(JSON.stringify([first.evidence(), first.routing()])).not.toMatch(/private-/);
      expect(first.evidence()[0].providerDiagnostic).toEqual({ status: 400, code: "400", type: "invalid_request_error",
        provider: "amazon-bedrock", category: "tool-or-parameter" });
      // The failed attempt's own route stays stopped.
      expect(await first.request()).toBe(409);
      // Another issue in the same cohort still reserves and completes.
      const second = await h.attempt("MOV-13");
      expect(await second.request()).toBe(200);
      expect(h.store.state()).toMatchObject({ status: "active", pending: 0 });
      expect(h.store.state().spentUsd).toBeCloseTo(5.25, 6);
      second.stop();
    } finally { first.stop(); await h.cleanup(); }
  }, 20000);

  it.each([[503, "{}"], [403, JSON.stringify({ error: { code: 403, message: "forbidden" } })]])("still stops the whole cohort on %s", async (status, body) => {
    const h = await harness((res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); });
    const attempt = await h.attempt("MOV-11");
    try {
      expect(await attempt.request()).toBe(502);
      expect(h.store.state().status).not.toBe("active");
      expect(h.store.export().stoppedReason).toMatch(new RegExp(`^provider-http-${status}`));
    } finally { attempt.stop(); await h.cleanup(); }
  }, 20000);
});
