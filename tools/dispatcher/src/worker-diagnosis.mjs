// Advisory diagnosis for the residual "unrecognized worker failure" bucket
// (MOV-179). This module never decides whether an issue escalates — MOV-151's
// policy already made that call before this is ever invoked — it only writes
// a better explanation for a `Needs Human Decision` comment that would
// otherwise be a raw log dump. See docs/operators/local-execution.md
// §Security model for the advisory-only framing this is careful to preserve.
//
// One bounded, cheap-tier model call, no retries, with a hard fallback: any
// failure here (missing key, network error, timeout, malformed response) is
// reported as `{ ok: false }` and the caller falls back to its existing
// generic comment. The escalation itself never depends on this succeeding.

import { redactWorkerOutput } from "./worker-spawn.mjs";
import { modelIdForTier } from "./worker-routing.mjs";

const MAX_LOG_CHARS = 8_000;
const MAX_AUDIT_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 512;

const DIAGNOSIS_TOOL = {
  name: "report_diagnosis",
  description: "Report a grounded diagnosis of why a dispatched worker run failed.",
  input_schema: {
    type: "object",
    properties: {
      confident: {
        type: "boolean",
        description: "True only if a specific error signature (exit code, api_error_status, matched log line/pattern) was actually found in the evidence.",
      },
      diagnosis: {
        type: "string",
        description: "The grounded diagnosis, naming the specific signature found. If not confident, say plainly that no specific cause could be identified rather than guessing.",
      },
      evidence: {
        type: "string",
        description: "The exact log line, error code, or pattern the diagnosis is grounded in. Omit only when not confident.",
      },
    },
    required: ["confident", "diagnosis"],
  },
};

const SYSTEM_PROMPT = `You are a diagnostic assistant for a software dispatcher. A worker run failed in a way the dispatcher's deterministic classifiers did not recognize — it is not a provider rate limit, not a credential failure, and not a security-policy block, all of which are already handled elsewhere. This failure is about to be escalated to a human as "Needs Human Decision", and today's escalation comment is just the raw log tail, which is slow for a human to read.

Read the evidence below and name the SPECIFIC error signature you find: an exit code, an api_error_status field, a matched stack trace or error message, a distinctive log line. Do not summarize what the worker was trying to do or restate its task. Quote the exact evidence you are relying on.

If you cannot confidently identify a specific cause from the evidence — the log is empty, generic, or ambiguous — set confident to false and say so plainly. A wrong confident-sounding diagnosis is worse than admitting uncertainty for a human trying to act quickly, so never fabricate a plausible-sounding cause you cannot ground in the evidence.

Report your finding using the report_diagnosis tool.`;

function bounded(text, maxChars) {
  const str = String(text || "");
  return str.length > maxChars ? str.slice(-maxChars) : str;
}

/**
 * Diagnose an unrecognized worker failure from its log tail and any
 * available audit text. One bounded call, no retries; every failure mode
 * (missing key, network/timeout error, non-2xx response, malformed or empty
 * response) returns `{ ok: false, reason }` rather than throwing, so a
 * caller can always fall back to its existing generic comment.
 *
 * @param {object} args
 * @param {number} [args.exitCode]
 * @param {string} [args.logTail] - untrusted worker transcript/log text
 * @param {string} [args.auditText] - untrusted audit/error text
 * @param {string} [args.apiKey] - defaults to process.env.ANTHROPIC_API_KEY
 * @param {typeof fetch} [args.fetchFn] - defaults to the global fetch
 * @param {string} [args.model] - defaults to the "cheap" Claude model tier
 * @param {number} [args.timeoutMs] - defaults to 20s
 * @returns {Promise<{ok: true, confident: boolean, diagnosis: string, evidence: string|null} | {ok: false, reason: string}>}
 */
export async function diagnoseUnrecognizedFailure({
  exitCode,
  logTail,
  auditText,
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchFn = fetch,
  model = modelIdForTier("claude", "cheap"),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apiKey) {
    return { ok: false, reason: "ANTHROPIC_API_KEY not set — diagnosis skipped" };
  }

  // Defense in depth: the log tail has already passed through
  // redactWorkerOutput once at write time (worker-spawn.mjs), but this
  // boundary sends text to a network call, so it is redacted again here
  // rather than trusting the caller did it upstream.
  const redactedLog = bounded(redactWorkerOutput(logTail), MAX_LOG_CHARS);
  const redactedAudit = bounded(redactWorkerOutput(auditText), MAX_AUDIT_CHARS);

  const userPrompt = [
    `Exit code: ${exitCode ?? "unknown"}`,
    "",
    "Log tail:",
    redactedLog || "(empty)",
    "",
    "Audit record:",
    redactedAudit || "(empty)",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        tools: [DIAGNOSIS_TOOL],
        tool_choice: { type: "tool", name: DIAGNOSIS_TOOL.name },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, reason: `diagnosis call failed: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, reason: `diagnosis call failed (HTTP ${res.status}): ${body.slice(0, 200)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, reason: `diagnosis response was not valid JSON: ${err?.message || err}` };
  }

  const toolUse = (Array.isArray(data?.content) ? data.content : []).find(
    (block) => block?.type === "tool_use" && block?.name === DIAGNOSIS_TOOL.name,
  );
  if (!toolUse || typeof toolUse.input !== "object" || toolUse.input === null) {
    return { ok: false, reason: "diagnosis call did not return a structured report" };
  }

  const { confident, diagnosis, evidence } = toolUse.input;
  if (typeof diagnosis !== "string" || !diagnosis.trim()) {
    return { ok: false, reason: "diagnosis call returned an empty diagnosis" };
  }

  return {
    ok: true,
    confident: confident === true,
    diagnosis: diagnosis.trim(),
    evidence: typeof evidence === "string" && evidence.trim() ? evidence.trim() : null,
  };
}
