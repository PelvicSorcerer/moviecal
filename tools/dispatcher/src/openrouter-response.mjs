// MOV-429: observe Responses without persisting prompts, tool payloads or
// provider error messages. Unknown attribution remains null, never estimated.
import { StringDecoder } from "node:string_decoder";

const id = (v) => typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v) ? v : null;
// Diagnostic only, never used for a decision: a bounded copy of a provider
// string so a failed identity check can be explained from the run log.
const shown = (v) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || null : null;
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

// Diagnostic only, never used for a decision: scalars that are numbers,
// booleans or identifier-shaped strings survive; free text is replaced and
// nested values are reduced to bounded key names or a length.
const rawEffort = (v) => v == null ? null : typeof v === "string" ? shown(v) : `[${typeof v}]`;

function redactedEntry(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const out = {};
  for (const [key, child] of Object.entries(row).slice(0, 32)) {
    if (!id(key) || key.length > 64) continue;
    if (typeof child === "number" || typeof child === "boolean" || child === null) out[key] = child;
    else if (typeof child === "string") out[key] = id(child) ? child : "[redacted]";
    else if (Array.isArray(child)) out[key] = { length: child.length };
    else if (typeof child === "object") out[key] = { keys: Object.keys(child).filter((k) => id(k) && k.length <= 64).slice(0, 16) };
  }
  return out;
}

// Diagnostic only, never used for a decision: Jev's "reconsidered" step,
// whether it is a pipeline stage or a field of the jev-router stage.
function reconsideredEvidence(pipeline, jev) {
  const named = (key) => typeof key === "string" && /reconsider/i.test(key);
  const stages = Array.isArray(pipeline) && pipeline.length <= 64 ? pipeline : [];
  const found = [
    ...stages.filter((stage) => named(stage?.name)).slice(0, 4).map((stage) => ({ source: "stage", name: shown(stage.name), data: redactedEntry(stage.data) })),
    ...Object.keys(jev || {}).filter((key) => id(key) && named(key)).slice(0, 4).map((key) => ({ source: "jev-field", name: key, data: redactedEntry(jev[key]) })),
  ];
  return { stageNames: stages.slice(0, 16).map((stage) => shown(stage?.name)), found };
}

export function createResponseObserver({ modelAliases = {}, proofDebug = false, deferCompletion = false, control = null, rejectFallback = false, provenModels = null, rewriteEvent = null } = {}) {
  const canonical = (model) => id(modelAliases[model]) || id(model);
  // A pinned alias must match exactly. Otherwise the endpoint may report the
  // resolved ID plus one strict `-YYYYMMDD` snapshot suffix, nothing else.
  function servedModelMatches(resolved, served) {
    if (canonical(served) === canonical(resolved)) return true;
    if (id(modelAliases[resolved])) return false;
    const base = id(resolved), got = id(served);
    const match = base && got && got.startsWith(`${base}-`) ? /^(\d{4})(\d{2})(\d{2})$/.exec(got.slice(base.length + 1)) : null;
    if (!match) return false;
    const [y, m, d] = match.slice(1).map(Number), date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }
  const decoder = new StringDecoder("utf8");
  let pending = "", completed = false, reason = null, snapshot = {}, toolCalls = 0;
  let ended = false, debugCount = 0, debug = null;
  let offeredTools = null, requestedEffort = null;
  let terminal = "";
  const fail = (code) => { reason ??= code; };
  function forward(raw) {
    if (!deferCompletion || !completed) return `${raw}\n\n`;
    // Codex stops reading on completion; drain final routing metadata first.
    terminal += `${raw}\n\n`;
    if (terminal.length > 1024 * 1024) { terminal = ""; fail("response-frame-too-large"); }
    return "";
  }
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
    if (value.type === "response.completed") snapshot.responseEffort = effort(response.reasoning?.effort);
  }
  function frame(raw) {
    if (raw.length > 1024 * 1024) { fail("response-frame-too-large"); return ""; }
    const data = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return forward(raw);
    try {
      const value = rewriteEvent ? rewriteEvent(JSON.parse(data)) : JSON.parse(data);
      if (!value) return "";
      event(value);
      if (value.type === "response.debug" || Object.hasOwn(value, "debug")) return "";
      return forward(rewriteEvent && value.type === "response.output_item.done"
        ? `data: ${JSON.stringify(value)}` : raw);
    } catch { fail("malformed-response"); return ""; }
  }
  function end() {
    if (ended) return "";
    ended = true;
    pending += decoder.end();
    const tail = pending.trim() ? frame(pending) : "";
    pending = "";
    const result = tail + terminal; terminal = "";
    return result;
  }
  return {
    setRequestedEffort(value) { requestedEffort = effort(value); },
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
      const stages = Array.isArray(snapshot.metadata?.pipeline) && snapshot.metadata.pipeline.length <= 64
        ? snapshot.metadata.pipeline.filter((stage) => stage?.name === "jev-router") : [];
      const jev = stages.length === 1 ? stages[0].data : null;
      const model = id(snapshot.model);
      const resolvedModel = model === "typesafe/jev-router" ? null : model;
      // Jev may list the dated snapshot of the model it resolved; the same
      // strict matcher as the endpoint check applies, and nothing looser.
      const listedMatches = (name) => id(name) && id(resolvedModel) && servedModelMatches(resolvedModel, name);
      const candidates = Array.isArray(jev?.candidates) && jev.candidates.length <= 128
        ? jev.candidates.filter((row) => listedMatches(row?.model)) : [];
      const selectedByJev = Array.isArray(jev?.resolved_models) && jev.resolved_models.length <= 128
        && jev.resolved_models.some(listedMatches);
      const listedNames = (list) => Array.isArray(list) ? list.slice(0, 8).map((item) => shown(typeof item === "string" ? item : item?.model)) : null;
      const candidateEffort = candidates.length === 1 ? effort(candidates[0].effort) : null;
      const routerCandidate = {
        matched: candidates.length, selectedByJev,
        candidateEffort, rawEffort: candidates.length === 1 ? rawEffort(candidates[0].effort) : null,
        entries: candidates.slice(0, 4).map(redactedEntry),
        // Diagnostic only: the names Jev listed, to explain a failed match.
        listedCandidates: listedNames(jev?.candidates), listedResolved: listedNames(jev?.resolved_models),
      };
      // Live contrast: caller low, completed response/candidate/upstream high.
      // Responses effort alone, evaluations and incumbent defaults are not proof.
      const responseEffort = snapshot.responseEffort || null;
      // Continuation turns: Jev may list only the model it already chose and
      // echo the caller's requested effort as that candidate's effort. That
      // echo is not a selection, so trust the response only when this run
      // already proved the same model on an earlier turn with a full match.
      const listed = Array.isArray(jev?.candidates) ? jev.candidates : [];
      const continuation = selectedByJev && candidateEffort && responseEffort && responseEffort !== candidateEffort
        && listed.length === 1 && candidates.length === 1 && candidateEffort === requestedEffort
        && provenModels?.has(canonical(resolvedModel));
      const routerEffort = selectedByJev && candidateEffort && (responseEffort === candidateEffort || continuation) ? responseEffort : null;
      if (selectedByJev && candidateEffort && responseEffort && responseEffort !== candidateEffort && !continuation) fail("conflicting-served-effort");
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
        endpointModel: shown(endpoint?.model), endpointProvider: shown(endpoint?.provider), endpointTag: shown(endpoint?.tag),
        // Bounded field names identify an upstream schema gap without saving
        // arbitrary plugin data, prompt text or reasoning content.
        routerStageKeys: Object.keys(jev || {}).filter((key) => id(key)).slice(0, 32),
        routerCandidate,
        routerReconsidered: reconsideredEvidence(snapshot.metadata?.pipeline, jev),
        routerEffortHints: proofDebug ? effortHints(jev) : [],
        responseEffort,
        // Responses reasoning can echo the request; it is not proof of Jev's
        // effective selection. A disposable diagnostic can instead report
        // the correlated upstream request with an explicit source marker.
        resolvedEffort: control ? responseEffort : routerEffort || forwardedEffort,
        resolvedEffortSource: control ? (responseEffort ? "completed-fixed-response" : null)
          : routerEffort ? (continuation ? "response-and-proven-continuation" : "response-and-jev-selection") : forwardedEffort ? "upstream-request" : null,
        debugCount, upstreamModel: debug?.model || null, upstreamEffort: debug?.effort || null, upstreamKeys: debug?.keys || [],
        inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
        cacheReadTokens: count(usage.input_tokens_details?.cached_tokens),
        cacheWriteTokens: count(usage.input_tokens_details?.cache_write_tokens),
        billedUsd: usd(usage.cost), invoiceId: id(snapshot.invoiceId), toolCalls,
        fallback: typeof snapshot.metadata?.attempt === "number" ? snapshot.metadata.attempt > 1 : null,
      };
      if (resolvedModel && endpoint?.model && !servedModelMatches(resolvedModel, endpoint.model)) fail("conflicting-served-model");
      if (control && (canonical(resolvedModel) !== canonical(control.model)
        || canonical(endpoint?.model) !== canonical(control.model)
        || endpoint?.provider !== control.provider || responseEffort !== control.effort
        || snapshot.metadata?.attempt !== 1)) fail("fixed-control-identity-mismatch");
      if (rejectFallback && snapshot.metadata?.attempt !== 1) fail("unapproved-provider-fallback");
      if (!reason && ["resolvedModel", "provider", "resolvedEffort", "inputTokens", "outputTokens", "cacheReadTokens", "billedUsd", "invoiceId"].some((field) => record[field] === null)) fail("missing-provider-attribution");
      // Only a full, unambiguous match on a multi-candidate turn proves a model.
      if (!reason && provenModels && routerEffort && !continuation && listed.length > 1) provenModels.add(canonical(resolvedModel));
      return { ...record, error: reason };
    },
  };
}
