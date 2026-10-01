// Trusted local provider broker. Launched only by codex-supervisor from a
// protected per-run copy. It never forwards an arbitrary URL or request path.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { buildOpenRouterRequest } from "./openrouter-transport.mjs";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const token = process.env.MOVIECAL_PROVIDER_BROKER_TOKEN;
const port = Number(process.env.MOVIECAL_PROVIDER_BROKER_PORT);
const upstream = new URL(config.upstream);
if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65535
  || !["http:", "https:"].includes(upstream.protocol) || upstream.pathname !== "/v1/responses"
  || upstream.search || upstream.hash || config.policy?.model !== "typesafe/jev-router") {
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
const authorized = (header) => {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(String(header || ""));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const server = http.createServer(async (request, response) => {
  if (!authorized(request.headers.authorization) || request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(403); response.end(); return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) throw new Error("request too large");
    }
    const parsed = buildOpenRouterRequest(JSON.parse(body), config.policy);
    const outbound = (upstream.protocol === "https:" ? https : http).request(upstream, {
      method: "POST", timeout: 30000,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-openrouter-metadata": "enabled" },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, {
        "content-type": upstreamResponse.headers["content-type"] || "application/json",
      });
      upstreamResponse.pipe(response);
    });
    outbound.setTimeout(30000, () => outbound.destroy(new Error("provider timeout")));
    response.on("close", () => outbound.destroy());
    outbound.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    outbound.end(JSON.stringify(parsed));
  } catch {
    if (!response.headersSent) response.writeHead(400);
    response.end();
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write("ready\n"));
