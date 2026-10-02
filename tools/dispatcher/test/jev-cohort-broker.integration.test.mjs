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

describe.skipIf(isInsideWorkerSandboxEnv())("shared fixed Responses broker boundary", () => {
  it("reads fake key/credit metadata, invoices one fixed request, and refuses traffic after stop", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mov437-broker-"));
    const dir = path.join(home, ".config", "moviecal"), logDir = path.join(home, "logs");
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(logDir);
    const now = new Date(), later = new Date(now.getTime() + 86400000).toISOString();
    const policy = { trialId: "fake-control", route: "codex-openrouter-responses",
      activatedAt: now.toISOString(), expiresAt: later, pairs: [{ routed: "MOV-10", control: "MOV-11" }],
      routed: { model: "typesafe/jev-router", worker: "codex", tier: "default" },
      control: { model: "openai/fixture", worker: "codex", provider: "OpenAI", providerSlug: "openai", effort: "medium", tier: "default" },
      keyId: "fake_key", workspaceId: "fake_workspace", keyLimitUsd: 69, allInCeilingUsd: 75,
      priorOutlayUsd: 5, baselineKeyUsageUsd: 1, purchaseFeesUsd: 0,
      modelAliases: { "openai/fixture": "openai/fixture" } };
    const configPath = path.join(dir, "jev-cohort.json"), approvalPath = path.join(dir, "jev-cohort-approval.json"), ledgerPath = path.join(dir, "jev-cohort-ledger.json");
    fs.writeFileSync(configPath, JSON.stringify({ enabled: false, policy }), { mode: 0o600 });
    fs.writeFileSync(approvalPath, JSON.stringify({ issue: "MOV-431", owner: "Adam Moore", ownerApproved: true,
      securityReviewPassed: true, accountPolicyReviewed: true, effectiveEligibilityUnrestricted: true,
      promptLoggingOff: true, zdrOff: true, dataCollectionUnrestricted: true, priorOutlayBasisReviewed: true,
      existingCreditOnlyReviewed: true, hardKeyCapReviewed: true, dedicatedKeyExclusiveReviewed: true,
      paymentBound: "dedicated-key-total-limit",
      keyLimitUsd: 69, allInCeilingUsd: 75, keyId: policy.keyId, workspaceId: policy.workspaceId,
      policySha256: policyDigest(policy), reviewedAt: now.toISOString(), expiresAt: later,
      availableCreditUsd: 0.5, totalCreditsUsd: 10.5, totalUsageUsd: 10, keyRemainingUsd: 68 }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "openrouter-jev.env"), "OPENROUTER_API_KEY=fake-openrouter-key\n", { mode: 0o600 });
    const store = new JevCohortStore({ home, configPath, approvalPath, ledgerPath });
    store.activate(now);
    const record = store.admit({ identifier: "MOV-11", labels: ["worker:codex"] },
      { worker: "codex", tier: "default", effort: "medium", now }).record;
    let seen = 0;
    const provider = http.createServer(async (req, res) => {
      expect(req.headers.authorization).toBe("Bearer fake-openrouter-key");
      if (req.url === "/api/v1/key") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: { limit: 69, usage: 1, limit_remaining: 68 } })); return; }
      if (req.url === "/api/v1/credits") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: { total_credits: 10.5, total_usage: 10 } })); return; }
      seen++;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      expect(body.model).toBe("openai/fixture");
      expect(body).not.toHaveProperty("parallel_tool_calls");
      expect(body.provider).toEqual({ only: ["openai"], allow_fallbacks: false, require_parameters: true });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: {
        id: "invoice-1", model: "openai/fixture", reasoning: { effort: "medium" }, status: "completed",
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, cost: 0.2 },
        openrouter_metadata: { attempt: 1, pipeline: [], endpoints: { available: [{ selected: true, provider: "OpenAI", model: "openai/fixture" }] } },
      } })}\n\n`);
    });
    await listen(provider);
    const portHolder = http.createServer(); await listen(portHolder);
    const brokerPort = portHolder.address().port; await close(portHolder);
    const transport = resolveCohortTransport(store, record, { home });
    transport.upstream = `http://127.0.0.1:${provider.address().port}/v1/responses`;
    const brokerConfig = path.join(logDir, "openrouter-broker.json");
    fs.writeFileSync(brokerConfig, JSON.stringify({ ...transport, fixture: true,
      accounting: { issue: "MOV-11", attemptId: "attempt-1" },
      modelAliases: policy.modelAliases, maxRequests: null, proofDebug: false }), { mode: 0o600 });
    const child = spawn(process.execPath, [path.resolve("tools/dispatcher/src/openrouter-broker.mjs"), brokerConfig],
      { env: { ...process.env, MOVIECAL_PROVIDER_BROKER_PORT: String(brokerPort), MOVIECAL_PROVIDER_BROKER_TOKEN: "fixture-broker-token" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready\n")) resolve(); });
        child.once("exit", () => reject(new Error("broker exited before readiness")));
        setTimeout(() => reject(new Error("broker readiness timeout")), 5000);
      });
      const request = () => fetch(`http://127.0.0.1:${brokerPort}/v1/responses`, { method: "POST",
        headers: { authorization: "Bearer fixture-broker-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/fixture", reasoning: { effort: "medium" },
          parallel_tool_calls: true, input: "fake only", stream: true }) });
      const first = await request(); expect(first.status).toBe(200); await first.text();
      expect(store.state()).toMatchObject({ status: "active", control: 1, spentUsd: 5.2, pending: 0 });
      expect(seen).toBe(1);
      store.stop("operator-stop");
      const second = await request(); expect(second.status).toBe(409); await second.text();
      expect(seen).toBe(1);
      const rows = fs.readFileSync(path.join(logDir, "routing-decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ routerArm: "fixed-control", billedUsd: 0.2, provider: "OpenAI", error: null });
    } finally {
      child.kill("SIGTERM"); await close(provider); fs.rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});
