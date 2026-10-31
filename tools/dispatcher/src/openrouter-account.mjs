// Broker-only account metadata read. Values are numeric evidence, never key
// material, and no response body is retained in a manifest or public log.
import http from "node:http";
import https from "node:https";

function getJson(url, key) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(url, { timeout: 10000, headers: { authorization: `Bearer ${key}` } }, (response) => {
      if (response.statusCode !== 200 || response.headers.location) { response.resume(); reject(new Error("account metadata unavailable")); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 65536) request.destroy(new Error("account metadata too large")); });
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid account metadata")); } });
    });
    request.on("timeout", () => request.destroy(new Error("account metadata timed out")));
    request.on("error", reject);
  });
}

export async function readOpenRouterAccount(upstream, key, { fixture = false } = {}) {
  const origin = new URL(upstream);
  if (!fixture && origin.origin !== "https://openrouter.ai") throw new Error("account endpoint is not allowlisted");
  const keyUrl = new URL("/api/v1/key", origin);
  const creditUrl = new URL("/api/v1/credits", origin);
  const [keyResponse, creditResponse] = await Promise.all([getJson(keyUrl, key), getJson(creditUrl, key)]);
  return parseOpenRouterAccount(keyResponse, creditResponse);
}

export function parseOpenRouterAccount(keyResponse, creditResponse) {
  const data = keyResponse?.data, credit = creditResponse?.data;
  const valid = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (data?.limit !== 69 || !valid(data.usage) || !valid(data.limit_remaining)
    || !valid(credit?.total_credits) || !valid(credit?.total_usage)
    || data.usage + data.limit_remaining > 69 + 1e-6
    || credit.total_usage > credit.total_credits) throw new Error("unknown or changed account allowance");
  return { keyUsageUsd: data.usage, keyRemainingUsd: data.limit_remaining,
    availableCreditUsd: credit.total_credits - credit.total_usage,
    totalCreditsUsd: credit.total_credits, totalUsageUsd: credit.total_usage };
}
