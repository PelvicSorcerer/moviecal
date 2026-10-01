// MOV-429: observe Responses without persisting prompts, tool payloads or
// provider error messages. Unknown attribution remains null, never estimated.
import { StringDecoder } from "node:string_decoder";

const id = (v) => typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v) ? v : null;
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const usd = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const effort = (v) => ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v) ? v : null;

// Discovery only, never attribution: a candidate/default effort may differ
// from the effort sent upstream. Bounded paths and enum values contain no
// prompts, evaluations, reasoning text or arbitrary plugin values.
function effortHints(data) {
  const hints = []; let visited = 0;
  function visit(value, prefix, depth) {
    if (!value || typeof value !== "object" || depth > 8 || ++visited > 1024 || hints.length >= 16) return;
    for (const [key, child] of Object.entries(value)) {
      if (++visited > 1024) return;
      if (key.length > 64 || !id(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (path.length > 256) continue;
      if (["effort", "reasoning_effort"].includes(key) && effort(child) && hints.length < 16) hints.push({ path, effort: child });
      if (visited < 1024 && hints.length < 16) visit(child, path, depth + 1);
    }
  }
  visit(data, "", 0);
  return hints;
}

export function createResponseObserver({ modelAliases = {}, proofDebug = false } = {}) {
  const canonical = (model) => id(modelAliases[model]) || id(model);
  const decoder = new StringDecoder("utf8");
  let pending = "", completed = false, reason = null, snapshot = {}, toolCalls = 0;
  let ended = false, debugCount = 0, debug = null;
  let offeredTools = null;
  const fail = (code) => { reason ??= code; };
  function event(value) {
    if (!value || typeof value !== "object") return fail("malformed-response");
    if (value.type === "response.debug") {
      if (!proofDebug) fail("unexpected-provider-debug");
      // Official Responses debug envelope. Keep only validated scalars; the
      // upstream body contains prompts/tools and must never reach Codex/logs.
      const body = value.debug?.echo_upstream_body;
      const nativeEffort = effort(body?.reasoning?.effort);
      const chatEffort = effort(body?.reasoning_effort);
      if (nativeEffort && chatEffort && nativeEffort !== chatEffort) fail("conflicting-served-effort");
      debugCount++;
      if (debugCount > 6) fail("too-many-upstream-debug-events");
      debug = { model: id(body?.model), effort: nativeEffort || chatEffort,
        keys: Object.keys(body || {}).filter((key) => id(key)).slice(0, 32) };
      return;
    }
    if (Object.hasOwn(value, "debug")) return fail("unsupported-provider-debug");
    if (value.error || ["error", "response.failed", "response.incomplete"].includes(value.type)) fail("provider-response-failed");
    if (value.type === "response.refusal.delta" || value.type === "response.refusal.done") fail("provider-refusal");
    const item = value.item;
    if (value.type === "response.output_item.done" && item) {
      if (["function_call", "custom_tool_call"].includes(item.type)) {
        toolCalls++;
        if (!id(item.call_id) || !id(item.name)) fail("malformed-tool-response");
        if (offeredTools && offeredTools.get(item.name) !== (item.type === "function_call" ? "function" : "custom")) fail("unsupported-tool-response");
        if (item.type === "function_call") {
          try { if (!JSON.parse(item.arguments) || typeof JSON.parse(item.arguments) !== "object") fail("malformed-tool-response"); }
          catch { fail("malformed-tool-response"); }
        } else if (typeof item.input !== "string") fail("malformed-tool-response");
      }
      if (item.content?.some?.((part) => part.type === "refusal")) fail("provider-refusal");
    }
    const response = value.response || value;
    if (value.type === "response.completed") {
      if (completed) return fail("duplicate-completion");
      completed = true;
      if (response.status && response.status !== "completed") fail("provider-response-failed");
    }
    // Router metadata can arrive as a final standalone chunk after completed.
    if (response.openrouter_metadata) snapshot.metadata = response.openrouter_metadata;
    if (response.model) snapshot.model = response.model;
    if (response.id) snapshot.invoiceId = response.id;
    if (response.usage) snapshot.usage = response.usage;
  }
  function frame(raw) {
    if (raw.length > 1024 * 1024) { fail("response-frame-too-large"); return ""; }
    const data = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return `${raw}\n\n`;
    try {
      const value = JSON.parse(data); event(value);
      if (value.type === "response.debug" || Object.hasOwn(value, "debug")) return "";
      return `${raw}\n\n`;
    } catch { fail("malformed-response"); return ""; }
  }
  function end() {
    if (ended) return "";
    ended = true;
    pending += decoder.end();
    const tail = pending.trim() ? frame(pending) : "";
    pending = "";
    return tail;
  }
  return {
    setTools(tools) {
      offeredTools = new Map((Array.isArray(tools) ? tools : []).filter((tool) => id(tool?.name)
        && ["function", "custom"].includes(tool.type)).map((tool) => [tool.name, tool.type]));
    },
    push(chunk) {
      let forwarded = "";
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      pending = pending.replaceAll("\r\n", "\n");
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) { forwarded += frame(pending.slice(0, end)); pending = pending.slice(end + 2); }
      if (pending.length > 1024 * 1024) { pending = ""; fail("response-frame-too-large"); }
      return forwarded;
    },
    end,
    finish() {
      end();
      if (!completed) fail("incomplete-response-stream");
      const selected = snapshot.metadata?.endpoints?.available?.filter?.((entry) => entry.selected === true) || [];
      const endpoint = selected.length === 1 ? selected[0] : null;
      const usage = snapshot.usage || {};
      const jev = snapshot.metadata?.pipeline?.find?.((stage) => stage.name === "jev-router")?.data;
      const model = id(snapshot.model);
      const resolvedModel = model === "typesafe/jev-router" ? null : model;
      const routerEffort = effort(jev?.reasoning_effort);
      // The last debug event is the last attempted upstream request. Require
      // the documented attempt count and a matching final selected model.
      // Native OpenAI IDs have the provider prefix removed; never guess other
      // providers' native naming schemes or derive effort from token budgets.
      const debugMatches = debug?.model && (canonical(debug.model) === canonical(endpoint?.model)
        || (["OpenAI", "Azure"].includes(endpoint?.provider) && canonical(endpoint?.model)?.startsWith("openai/")
          && canonical(`openai/${debug.model}`) === canonical(endpoint.model)));
      const forwardedEffort = proofDebug && debugMatches && debugCount === snapshot.metadata?.attempt ? debug?.effort : null;
      if (proofDebug && debugCount && !debugMatches) fail("conflicting-debug-model");
      if (proofDebug && debugCount && debugCount !== snapshot.metadata?.attempt) fail("ambiguous-upstream-debug");
      if (routerEffort && forwardedEffort && routerEffort !== forwardedEffort) fail("conflicting-served-effort");
      const record = {
        resolvedModel, provider: id(endpoint?.provider),
        canonicalModel: canonical(resolvedModel),
        // Bounded field names identify an upstream schema gap without saving
        // arbitrary plugin data, prompt text or reasoning content.
        routerStageKeys: Object.keys(jev || {}).filter((key) => id(key)).slice(0, 32),
        routerEffortHints: proofDebug ? effortHints(jev) : [],
        // Responses reasoning can echo the request; it is not proof of Jev's
        // effective selection. A disposable diagnostic can instead report
        // the correlated upstream request with an explicit source marker.
        resolvedEffort: routerEffort || forwardedEffort,
        resolvedEffortSource: routerEffort ? "jev-router" : forwardedEffort ? "upstream-request" : null,
        debugCount, upstreamModel: debug?.model || null, upstreamEffort: debug?.effort || null, upstreamKeys: debug?.keys || [],
        inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
        cacheReadTokens: count(usage.input_tokens_details?.cached_tokens),
        cacheWriteTokens: count(usage.input_tokens_details?.cache_write_tokens),
        billedUsd: usd(usage.cost), invoiceId: id(snapshot.invoiceId), toolCalls,
        fallback: typeof snapshot.metadata?.attempt === "number" ? snapshot.metadata.attempt > 1 : null,
      };
      if (resolvedModel && endpoint?.model && canonical(endpoint.model) !== canonical(resolvedModel)) fail("conflicting-served-model");
      if (!reason && ["resolvedModel", "provider", "resolvedEffort", "inputTokens", "outputTokens", "cacheReadTokens", "billedUsd", "invoiceId"].some((field) => record[field] === null)) fail("missing-provider-attribution");
      return { ...record, error: reason };
    },
  };
}
