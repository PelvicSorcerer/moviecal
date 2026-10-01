// MOV-429: observe Responses without persisting prompts, tool payloads or
// provider error messages. Unknown attribution remains null, never estimated.
import { StringDecoder } from "node:string_decoder";

const id = (v) => typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v) ? v : null;
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const usd = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export function createResponseObserver() {
  const decoder = new StringDecoder("utf8");
  let pending = "", completed = false, reason = null, snapshot = {}, toolCalls = 0;
  const fail = (code) => { reason ??= code; };
  function event(value) {
    if (!value || typeof value !== "object") return fail("malformed-response");
    if (value.error || ["error", "response.failed", "response.incomplete"].includes(value.type)) fail("provider-response-failed");
    if (value.type === "response.refusal.delta" || value.type === "response.refusal.done") fail("provider-refusal");
    const item = value.item;
    if (value.type === "response.output_item.done" && item) {
      if (["function_call", "custom_tool_call"].includes(item.type)) {
        toolCalls++;
        if (!id(item.call_id) || !id(item.name)) fail("malformed-tool-response");
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
    const data = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    try { event(JSON.parse(data)); } catch { fail("malformed-response"); }
  }
  return {
    push(chunk) {
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      pending = pending.replaceAll("\r\n", "\n");
      let end;
      while ((end = pending.indexOf("\n\n")) >= 0) { frame(pending.slice(0, end)); pending = pending.slice(end + 2); }
      if (pending.length > 1024 * 1024) { pending = ""; fail("response-frame-too-large"); }
    },
    finish() {
      pending += decoder.end();
      if (pending.trim()) frame(pending);
      if (!completed) fail("incomplete-response-stream");
      const selected = snapshot.metadata?.endpoints?.available?.filter?.((entry) => entry.selected === true) || [];
      const endpoint = selected.length === 1 ? selected[0] : null;
      const usage = snapshot.usage || {};
      const jev = snapshot.metadata?.pipeline?.find?.((stage) => stage.name === "jev-router")?.data;
      const model = id(snapshot.model);
      const resolvedModel = model === "typesafe/jev-router" ? null : model;
      const record = {
        resolvedModel, provider: id(endpoint?.provider),
        // Responses reasoning can echo the request; it is not proof of Jev's
        // effective selection. Only accept an explicit router-stage report.
        resolvedEffort: id(jev?.reasoning_effort),
        inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
        cacheReadTokens: count(usage.input_tokens_details?.cached_tokens),
        cacheWriteTokens: count(usage.input_tokens_details?.cache_write_tokens),
        billedUsd: usd(usage.cost), invoiceId: id(snapshot.invoiceId), toolCalls,
        fallback: typeof snapshot.metadata?.attempt === "number" ? snapshot.metadata.attempt > 1 : null,
      };
      if (resolvedModel && endpoint?.model && endpoint.model !== resolvedModel) fail("conflicting-served-model");
      if (!reason && ["resolvedModel", "provider", "resolvedEffort", "inputTokens", "outputTokens", "cacheReadTokens", "billedUsd", "invoiceId"].some((field) => record[field] === null)) fail("missing-provider-attribution");
      return { ...record, error: reason };
    },
  };
}
