// Trusted local provider broker. Launched only by codex-supervisor from a
// protected per-run copy. It never forwards an arbitrary URL or request path.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { buildOpenRouterRequest, OPENROUTER_UPSTREAM } from "./openrouter-transport.mjs";
import { createResponseObserver } from "./openrouter-response.mjs";
import { parseRoutedRequests, writeRoutedRequestEvidence } from "./routed-request.mjs";
import { JevCohortStore, assertCohortBinding } from "./jev-cohort.mjs";
import { readOpenRouterAccount } from "./openrouter-account.mjs";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const token = process.env.MOVIECAL_PROVIDER_BROKER_TOKEN;
const port = Number(process.env.MOVIECAL_PROVIDER_BROKER_PORT);
const upstream = new URL(config.upstream);
if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65535
  || !(upstream.href === OPENROUTER_UPSTREAM || (config.fixture === true
    && upstream.protocol === "http:" && upstream.hostname === "127.0.0.1" && upstream.pathname === "/v1/responses"))
  || upstream.search || upstream.hash || !/^[A-Za-z0-9_.:/-]{1,200}$/.test(config.policy?.model || "")
  || (config.policy.model !== "typesafe/jev-router" && config.policy.side !== "control")) {
  throw new Error("provider broker setup invalid");
}
const stat = fs.lstatSync(config.credentialPath);
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
  throw new Error("provider credential unavailable");
}
const credential = fs.readFileSync(config.credentialPath, "utf8").trim();
const match = /^OPENROUTER_API_KEY=([A-Za-z0-9_-]{8,256})$/.exec(credential);
if (!match) throw new Error("provider credential invalid");
const key = match[1];
const cohort = config.cohort ? new JevCohortStore(config.cohort) : null;
if (cohort && (!cohort.get(config.cohort.issue) || cohort.state().status !== "active")) throw new Error("cohort broker admission unavailable");
if (cohort) assertCohortBinding(cohort, config);
if (config.proofDebug === true && (!Number.isInteger(config.maxRequests) || config.maxRequests < 1 || config.maxRequests > 6)) {
  throw new Error("provider debug requires a capped disposable proof");
}
let stopped = false, turn = 0, admitted = 0;
if (config.maxRequests !== null && config.maxRequests !== undefined
  && (!Number.isInteger(config.maxRequests) || config.maxRequests < 1 || config.maxRequests > 6)) throw new Error("provider request cap invalid");
const authorized = (header) => {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(String(header || ""));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const server = http.createServer(async (request, response) => {
  if (!authorized(request.headers.authorization) || request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(403); response.end(); return;
  }
  if (stopped || (cohort && cohort.state().status !== "active")) {
    response.writeHead(409); response.end('{"error":{"code":"route-stopped"}}'); return;
  }
  const requestId = randomUUID(), started = Date.now();
  const observer = createResponseObserver({ modelAliases: config.modelAliases, proofDebug: config.proofDebug === true,
    deferCompletion: true, rejectFallback: Boolean(cohort), control: config.policy.side === "control" ? { model: config.policy.model,
      provider: config.policy.provider, effort: config.policy.effort } : null });
  let recorded = false, toolOutputs = 0, requestedEffort = null, account = null, reserved = false;
  const record = (error = null) => {
    if (recorded) return;
    recorded = true;
    const observed = observer.finish();
    let failure = error || observed.error;
    if (failure) { stopped = true; cohort?.stop(failure); }
    if (cohort && reserved && !failure) {
      try { cohort.finish(requestId, { invoiceId: observed.invoiceId, amountUsd: observed.billedUsd,
        model: observed.resolvedModel, provider: observed.provider, effort: observed.resolvedEffort, account });
      }
      catch { stopped = true; cohort.stop("invoice-reconciliation-failed"); failure = "invoice-reconciliation-failed"; }
      if (!failure) {
        // Account for already-paid work under its original assignment even
        // when approval was revoked in flight, then refuse terminal success.
        try { assertCohortBinding(cohort, config); }
        catch { stopped = true; cohort.stop("cohort-approval-changed-in-flight"); failure = "cohort-approval-changed-in-flight"; }
      }
    }
    const events = [
      { type: "request.start", requestId, ...config.accounting, turn: ++turn,
        routerArm: config.policy.side === "control" ? "fixed-control" : "jev-hosted",
        policyHash: config.policy.hash, requestedModel: config.policy.model, requestedEffort },
      { type: "request.chunk", requestId, ...observed, streamed: true },
      { type: "request.usage", requestId, usage: observed },
      { type: "request.end", requestId, ...observed, latencyMs: Date.now() - started, error: failure },
    ];
    const evidence = parseRoutedRequests(events.map((event) => JSON.stringify(event)).join("\n")).records[0];
    writeRoutedRequestEvidence(path.dirname(process.argv[2]), { ...evidence, source: "openrouter-responses",
      toolCalls: observed.toolCalls, toolOutputs });
    fs.appendFileSync(path.join(path.dirname(process.argv[2]), "openrouter-attribution.jsonl"),
      `${JSON.stringify({ requestId, invoiceId: observed.invoiceId, canonicalModel: observed.canonicalModel,
        routerStageKeys: observed.routerStageKeys, routerEffortHints: observed.routerEffortHints,
        responseEffort: observed.responseEffort,
        resolvedEffortSource: observed.resolvedEffortSource,
        debugCount: observed.debugCount, upstreamModel: observed.upstreamModel,
        upstreamEffort: observed.upstreamEffort, upstreamKeys: observed.upstreamKeys })}\n`, { mode: 0o600 });
    return failure;
  };
  if (config.maxRequests && admitted >= config.maxRequests) {
    record("request-cap"); response.writeHead(409); response.end('{"error":{"code":"request-cap"}}'); return;
  }
  admitted++;
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) throw new Error("request too large");
    }
    const parsed = buildOpenRouterRequest(JSON.parse(body), config.policy);
    observer.setTools(parsed.tools);
    if (config.proofDebug === true) parsed.debug = { echo_upstream_body: true };
    toolOutputs = Array.isArray(parsed.input) ? parsed.input.filter((item) => ["function_call_output", "custom_tool_call_output"].includes(item.type)).length : 0;
    requestedEffort = parsed.reasoning?.effort;
    if (cohort) {
      try {
        assertCohortBinding(cohort, config);
        account = await readOpenRouterAccount(config.upstream, key, { fixture: config.fixture === true });
        assertCohortBinding(cohort, config);
        cohort.reserve(requestId, config.cohort.issue, account);
        reserved = true;
      } catch {
        stopped = true;
        cohort.stop("account-preflight-or-budget-failed");
        record("account-preflight-or-budget-failed");
        response.writeHead(409); response.end('{"error":{"code":"cohort-budget-stopped"}}'); return;
      }
    }
    const outbound = (upstream.protocol === "https:" ? https : http).request(upstream, {
      method: "POST", timeout: 30000,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-openrouter-metadata": "enabled" },
    }, (upstreamResponse) => {
      if (upstreamResponse.statusCode !== 200) {
        record(`provider-http-${upstreamResponse.statusCode || 502}`);
        upstreamResponse.resume();
        response.writeHead(502, { "content-type": "application/json" });
        response.end('{"error":{"code":"provider-request-failed"}}');
        return;
      }
      if (!String(upstreamResponse.headers["content-type"]).startsWith("text/event-stream")) {
        record("unsupported-response-protocol"); upstreamResponse.resume();
        response.writeHead(502); response.end(); return;
      }
      upstreamResponse.on("data", (chunk) => {
        const safe = observer.push(chunk);
        if (safe && !response.write(safe)) upstreamResponse.pause();
      });
      response.on("drain", () => upstreamResponse.resume());
      upstreamResponse.on("end", () => {
        const safe = observer.end();
        if (record()) response.destroy();
        else response.end(safe);
      });
      upstreamResponse.on("error", () => { record("provider-stream-error"); response.destroy(); });
      response.writeHead(upstreamResponse.statusCode || 502, {
        "content-type": upstreamResponse.headers["content-type"] || "application/json",
      });
    });
    outbound.setTimeout(config.fixture ? 1000 : 30000, () => { record("provider-timeout"); outbound.destroy(); });
    response.on("close", () => { if (!recorded) record("client-disconnected"); outbound.destroy(); });
    outbound.on("error", () => { record("provider-outage"); if (!response.headersSent) response.writeHead(502); response.end(); });
    outbound.end(JSON.stringify(parsed));
  } catch {
    record("invalid-provider-request");
    if (!response.headersSent) response.writeHead(400);
    response.end();
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write("ready\n"));
