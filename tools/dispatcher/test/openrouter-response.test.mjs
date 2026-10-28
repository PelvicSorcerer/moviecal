import { describe, expect, it } from "vitest";
import { createResponseObserver } from "../src/openrouter-response.mjs";

const completed = () => ({ type: "response.completed", response: {
  id: "gen-fixture", model: "google/fixture", reasoning: { effort: "low" },
  usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 10 }, cost: 0.002 },
  openrouter_metadata: { attempt: 1, pipeline: [{ name: "jev-router", data: { resolved_models: ["google/fixture"], candidates: [{ model: "google/fixture", effort: "low" }] } }], endpoints: { available: [{ model: "google/fixture", provider: "Google", selected: true }] } },
} });
function observe(events, options) {
  const observer = createResponseObserver(options);
  const bytes = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  for (let offset = 0; offset < bytes.length; offset += 7) observer.push(bytes.subarray(offset, offset + 7));
  return observer.finish();
}
describe("OpenRouter Responses evidence", () => {
  it("attributes a fixed control without inventing a Jev selection", () => {
    const event = completed();
    event.response.model = "openai/fixture";
    event.response.reasoning.effort = "medium";
    event.response.openrouter_metadata.pipeline = [];
    event.response.openrouter_metadata.endpoints.available = [{ selected: true, provider: "OpenAI", model: "openai/fixture-20261001" }];
    const opts = { control: { model: "openai/fixture", provider: "OpenAI", effort: "medium" },
      modelAliases: { "openai/fixture": "openai/fixture-20261001" } };
    expect(observe([event], opts)).toMatchObject({ error: null, resolvedEffort: "medium",
      resolvedEffortSource: "completed-fixed-response", routerStageKeys: [], billedUsd: 0.002 });
    event.response.openrouter_metadata.endpoints.available[0].provider = "Azure";
    expect(observe([event], opts).error).toBe("fixed-control-identity-mismatch");
    event.response.openrouter_metadata.endpoints.available[0].provider = "OpenAI";
    delete event.response.reasoning;
    expect(observe([event], opts).error).toBe("fixed-control-identity-mismatch");
  });
  it("holds completion until final standalone metadata has been drained", () => {
    const observer = createResponseObserver({ deferCompletion: true });
    const event = completed(), metadata = event.response.openrouter_metadata;
    delete event.response.openrouter_metadata;
    const terminal = `data: ${JSON.stringify(event)}\n\n`;
    expect(observer.push(terminal)).toBe("");
    const final = `data: ${JSON.stringify({ openrouter_metadata: metadata })}\n\n`;
    expect(observer.push(final + "data: [DONE]\n\n")).toBe("");
    expect(observer.end()).toBe(terminal + final + "data: [DONE]\n\n");
    expect(observer.finish().error).toBe(null);
  });
  const debugEvent = (model = "google/fixture", value = "medium") => ({ type: "response.debug", sequence_number: 0,
    debug: { echo_upstream_body: { model, reasoning_effort: value, messages: [{ content: "PRIVATE_DEBUG_SENTINEL" }] } } });
  function debugCompletion() {
    const event = completed(); delete event.response.openrouter_metadata.pipeline;
    return event;
  }
  it("uses the forwarded effort instead of echoed Responses reasoning in a disposable diagnostic", () => {
    expect(observe([debugEvent(), debugCompletion()], { proofDebug: true })).toMatchObject({
      resolvedEffort: "medium", resolvedEffortSource: "upstream-request", debugCount: 1, error: null });
  });
  it.each(["OpenAI", "Azure"])("correlates native OpenAI IDs from %s using catalogue identities", (provider) => {
    const event = debugCompletion(); event.response.model = "openai/fixture";
    event.response.openrouter_metadata.endpoints.available[0] = { provider, model: "openai/fixture-20260929", selected: true };
    const debug = debugEvent("fixture"); delete debug.debug.echo_upstream_body.reasoning_effort;
    debug.debug.echo_upstream_body.reasoning = { effort: "high" };
    expect(observe([debug, event], { proofDebug: true, modelAliases: { "openai/fixture": "openai/fixture-20260929" } }))
      .toMatchObject({ resolvedEffort: "high", error: null });
    event.response.openrouter_metadata.endpoints.available[0].model = "openai/fixture-20260928";
    expect(observe([debug, event], { proofDebug: true, modelAliases: { "openai/fixture": "openai/fixture-20260929" } }).error).toBe("conflicting-debug-model");
  });
  it("uses the last debug attempt when routing metadata confirms the attempt count", () => {
    const event = debugCompletion(); event.response.openrouter_metadata.attempt = 2;
    expect(observe([debugEvent("other/model", "low"), debugEvent(), event], { proofDebug: true }))
      .toMatchObject({ resolvedEffort: "medium", debugCount: 2, fallback: true, error: null });
  });
  it.each([undefined, "invented", "PRIVATE_DEBUG_SENTINEL", 42])("does not invent effort for unsupported upstream value %s", (value) => {
    const debug = debugEvent(); debug.debug.echo_upstream_body.reasoning_effort = value;
    const result = observe([debug, debugCompletion()], { proofDebug: true });
    expect(result).toMatchObject({ resolvedEffort: null, error: "missing-provider-attribution" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DEBUG_SENTINEL");
  });
  it("rejects unsolicited, conflicting and ambiguous debug evidence", () => {
    expect(observe([debugEvent(), completed()]).error).toBe("unexpected-provider-debug");
    expect(observe([debugEvent("other/model"), debugCompletion()], { proofDebug: true }))
      .toMatchObject({ error: "conflicting-debug-model", resolvedEffort: null, upstreamEffort: "medium" });
    expect(observe([debugEvent(), debugEvent(), debugCompletion()], { proofDebug: true }).error).toBe("ambiguous-upstream-debug");
    expect(observe([debugEvent(), completed()], { proofDebug: true }).error).toBe("conflicting-served-effort");
    const debug = debugEvent(); debug.debug.echo_upstream_body.reasoning = { effort: "low" };
    expect(observe([debug, debugCompletion()], { proofDebug: true }).error).toBe("conflicting-served-effort");
  });
  it("strips fragmented debug frames while preserving normal Unicode tools and terminal frames", () => {
    const observer = createResponseObserver({ proofDebug: true });
    const tool = { type: "response.output_item.done", item: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: JSON.stringify({ cmd: "echo café" }) } };
    const raw = [debugEvent(), tool, debugCompletion()].map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    const bytes = Buffer.from(raw); let forwarded = "";
    for (let offset = 0; offset < bytes.length; offset += 7) forwarded += observer.push(bytes.subarray(offset, offset + 7));
    forwarded += observer.end();
    expect(forwarded).not.toMatch(/PRIVATE_DEBUG_SENTINEL|response.debug|echo_upstream_body/);
    expect(forwarded).toContain(JSON.stringify(tool)); expect(forwarded).toContain("data: [DONE]");
    expect(observer.finish()).toMatchObject({ resolvedEffort: "medium", toolCalls: 1, error: null });
  });
  it("drops oversized frames, unknown debug envelopes and malformed JSON before client forwarding", () => {
    const observer = createResponseObserver();
    expect(observer.push(`data: ${JSON.stringify({ type: "response.debug", debug: { echo_upstream_body: "x".repeat(1024 * 1024) } })}\n\n`)).toBe("");
    expect(observer.finish().error).toBe("response-frame-too-large");
    const unknown = createResponseObserver();
    expect(unknown.push('data: {"type":"unknown","debug":{"private":"PRIVATE_DEBUG_SENTINEL"}}\n\n')).toBe("");
    expect(unknown.finish().error).toBe("unsupported-provider-debug");
  });
  it("rejects a tool call that the contained client did not offer", () => {
    const observer = createResponseObserver(); observer.setTools([{ type: "function", name: "exec_command" }]);
    observer.push(`data: ${JSON.stringify({ type: "response.output_item.done", item: {
      type: "custom_tool_call", name: "apply_patch", call_id: "call-1", input: "PRIVATE_SENTINEL" } })}\n\n`);
    observer.push(`data: ${JSON.stringify(completed())}\n\n`);
    expect(observer.finish().error).toBe("unsupported-tool-response");
  });
  it("finds bounded nested effort hints without accepting candidate/default values as served effort", () => {
    const event = debugCompletion(); event.response.openrouter_metadata.pipeline = [{ name: "jev-router", data: {
      candidates: Array.from({ length: 100 }, () => ({ reasoning: { effort: "high" }, prompt: "PRIVATE_SENTINEL" })),
      evaluations: { effort: "PRIVATE_SENTINEL" } } }];
    const result = observe([event], { proofDebug: true });
    expect(result).toMatchObject({ resolvedEffort: null, error: "missing-provider-attribution" });
    expect(result.routerEffortHints).toHaveLength(16);
    expect(result.routerEffortHints[0]).toEqual({ path: "candidates.0.reasoning.effort", effort: "high" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    expect(observe([event]).routerEffortHints).toEqual([]);
  });
  it("parses split SSE frames and reported zeroes without copying content", () => {
    const event = completed(); event.response.usage.cost = 0;
    const result = observe([{ type: "response.output_text.delta", delta: "PRIVATE_SENTINEL" }, event]);
    expect(result).toMatchObject({ resolvedModel: "google/fixture", provider: "Google", resolvedEffort: "low",
      inputTokens: 20, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: null, billedUsd: 0, error: null, fallback: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  });
  it("attributes ordinary effort only to the unique served candidate and terminal response", () => {
    expect(observe([completed()])).toMatchObject({ resolvedEffort: "low", resolvedEffortSource: "response-and-jev-selection", debugCount: 0, error: null });
    const event = completed(); event.response.reasoning.effort = "high";
    expect(observe([event]).error).toBe("conflicting-served-effort");
  });
  it.each(["missing-selection", "other-candidate", "duplicate-candidate", "unknown-effort", "missing-response", "oversized-candidates", "duplicate-stage"])("rejects ordinary attribution for %s", (failure) => {
    const event = completed(), data = event.response.openrouter_metadata.pipeline[0].data;
    if (failure === "duplicate-stage") event.response.openrouter_metadata.pipeline.push({ name: "jev-router", data });
    if (failure === "missing-selection") data.resolved_models = [];
    if (failure === "other-candidate") data.candidates[0].model = "other/model";
    if (failure === "duplicate-candidate") data.candidates.push({ ...data.candidates[0] });
    if (failure === "unknown-effort") data.candidates[0].effort = "invented";
    if (failure === "missing-response") delete event.response.reasoning;
    if (failure === "oversized-candidates") data.candidates = Array(129).fill(data.candidates[0]);
    expect(observe([event])).toMatchObject({ resolvedEffort: null, error: "missing-provider-attribution" });
  });
  it("accepts terminal standalone routing metadata and records upstream fallback", () => {
    const event = completed(); const metadata = event.response.openrouter_metadata;
    delete event.response.openrouter_metadata; metadata.attempt = 2;
    expect(observe([event, { openrouter_metadata: metadata }])).toMatchObject({ provider: "Google", fallback: true, error: null });
  });
  it.each(["model", "usage", "id", "openrouter_metadata"])("makes absent %s an explicit no-go", (field) => {
    const event = completed(); delete event.response[field];
    expect(observe([event]).error).toBe("missing-provider-attribution");
  });
  it("does not infer served effort from echoed reasoning", () => {
    const event = completed(); delete event.response.openrouter_metadata.pipeline;
    expect(observe([event])).toMatchObject({ resolvedEffort: null, error: "missing-provider-attribution" });
  });
  it("recognizes only catalogue-confirmed canonical aliases", () => {
    const event = completed();
    event.response.openrouter_metadata.endpoints.available[0].model = "google/fixture-20260929";
    const options = { modelAliases: { "google/fixture": "google/fixture-20260929" } };
    expect(observe([event], options)).toMatchObject({ resolvedModel: "google/fixture", canonicalModel: "google/fixture-20260929", error: null });
    event.response.openrouter_metadata.endpoints.available[0].model = "google/fixture-20260928";
    expect(observe([event], options).error).toBe("conflicting-served-model");
  });
  it("accepts an unaliased dated snapshot of the same model ID and nothing looser", () => {
    const event = completed(), endpoint = event.response.openrouter_metadata.endpoints.available[0];
    endpoint.model = "google/fixture-20261023";
    expect(observe([event])).toMatchObject({ resolvedModel: "google/fixture", endpointModel: "google/fixture-20261023", error: null });
    for (const served of ["google/fixture-2026102", "google/fixture-202610234", "google/fixture-20261323", "google/fixture-20260231",
      "google/fixture-preview", "google/fixture-pro-20261023", "google/fixture-v2", "google/fixture20261023",
      "other/fixture-20261023", "google/fixture-20261023-x", "google/fixture-"]) {
      endpoint.model = served;
      expect(observe([event]).error, served).toBe("conflicting-served-model");
    }
    // A policy alias pins the snapshot, so a different date does not slip through.
    endpoint.model = "google/fixture-20261023";
    expect(observe([event], { modelAliases: { "google/fixture": "google/fixture-20260929" } }).error).toBe("conflicting-served-model");
  });
  it("reports a missing effort after alias normalization and saves only router field names", () => {
    const event = completed();
    event.response.openrouter_metadata.endpoints.available[0].model = "google/fixture-20260929";
    event.response.openrouter_metadata.pipeline[0].data = { resolved_models: ["google/fixture"], private_payload: "PRIVATE_SENTINEL" };
    const result = observe([event], { modelAliases: { "google/fixture": "google/fixture-20260929" } });
    expect(result).toMatchObject({ resolvedEffort: null, error: "missing-provider-attribution", routerStageKeys: ["resolved_models", "private_payload"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  });
  it("retains the chosen candidate's effort evidence, redacted and bounded, without changing the guard", () => {
    const event = completed(), data = event.response.openrouter_metadata.pipeline[0].data;
    expect(observe([event]).routerCandidate).toEqual({ matched: 1, selectedByJev: true, candidateEffort: "low", rawEffort: "low",
      entries: [{ model: "google/fixture", effort: "low" }], listedCandidates: ["google/fixture"], listedResolved: ["google/fixture"] });
    // No effort field: guard still stops, and the record says why.
    data.candidates = [{ model: "google/fixture", reasoning: { effort: "high", note: "PRIVATE_SENTINEL" },
      evaluation: "free text PRIVATE_SENTINEL", score: 0.5, tags: ["a", "b"] }];
    let result = observe([event]);
    expect(result).toMatchObject({ error: "missing-provider-attribution", resolvedEffort: null });
    expect(result.routerCandidate).toEqual({ matched: 1, selectedByJev: true, candidateEffort: null, rawEffort: null,
      entries: [{ model: "google/fixture", reasoning: { keys: ["effort", "note"] }, evaluation: "[redacted]", score: 0.5, tags: { length: 2 } }],
      listedCandidates: ["google/fixture"], listedResolved: ["google/fixture"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    // Non-enum effort is kept as a bounded string, and a mismatch still fails.
    data.candidates = [{ model: "google/fixture", effort: "Very high!" + "x".repeat(300) }];
    result = observe([event]);
    expect(result.error).toBe("missing-provider-attribution");
    expect(result.routerCandidate.rawEffort).toHaveLength(200);
    data.candidates = [{ model: "google/fixture", effort: "high" }];
    expect(observe([event]).error).toBe("conflicting-served-effort");
    // Bounded entries; no candidate.
    data.candidates = Array.from({ length: 10 }, () => ({ model: "google/fixture", effort: "low" }));
    expect(observe([event]).routerCandidate).toMatchObject({ matched: 10, candidateEffort: null });
    expect(observe([event]).routerCandidate.entries).toHaveLength(4);
    data.candidates = [{ model: "other/model", effort: "low" }];
    expect(observe([event]).routerCandidate).toMatchObject({ matched: 0, entries: [] });
  });
  it("logs Jev's reconsidered step, redacted and bounded, without changing the guard", () => {
    const event = completed(), metadata = event.response.openrouter_metadata, data = metadata.pipeline[0].data;
    expect(observe([event]).routerReconsidered).toEqual({ stageNames: ["jev-router"], found: [] });
    data.reconsidered = { final_model: "google/fixture", final_effort: "high", overrode_candidate: true, rationale: "PRIVATE_SENTINEL free text" };
    metadata.pipeline.push({ name: "reconsidered", data: { effort: "medium", note: "free text PRIVATE_SENTINEL" } });
    const result = observe([event]);
    expect(result.routerReconsidered).toEqual({ stageNames: ["jev-router", "reconsidered"], found: [
      { source: "stage", name: "reconsidered", data: { effort: "medium", note: "[redacted]" } },
      { source: "jev-field", name: "reconsidered", data: { final_model: "google/fixture", final_effort: "high", overrode_candidate: true, rationale: "[redacted]" } }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    expect(result.error).toBeNull();
    metadata.pipeline = Array.from({ length: 70 }, () => ({ name: "reconsidered" }));
    expect(observe([event]).routerReconsidered).toEqual({ stageNames: [], found: [] });
  });
  it("matches Jev's dated candidate and resolved names to the resolved model, and nothing looser", () => {
    const event = completed(), data = event.response.openrouter_metadata.pipeline[0].data;
    event.response.openrouter_metadata.endpoints.available[0].model = "google/fixture-20261023";
    data.resolved_models = ["google/fixture-20261023"];
    data.candidates = [{ model: "google/fixture-20261023", effort: "low" }];
    expect(observe([event])).toMatchObject({ resolvedEffort: "low", error: null,
      routerCandidate: { matched: 1, selectedByJev: true, candidateEffort: "low" } });
    // The proof is not relaxed: the candidate's effort must still match.
    data.candidates = [{ model: "google/fixture-20261023", effort: "high" }];
    expect(observe([event]).error).toBe("conflicting-served-effort");
    for (const listed of ["google/fixture-preview", "google/fixture-20261323", "other/fixture-20261023", "google/fixture-20261023-x"]) {
      data.resolved_models = [listed]; data.candidates = [{ model: listed, effort: "low" }];
      expect(observe([event]).routerCandidate, listed).toMatchObject({ matched: 0, selectedByJev: false, candidateEffort: null });
    }
    // A policy alias pins the snapshot for Jev's lists too.
    data.resolved_models = ["google/fixture-20261023"]; data.candidates = [{ model: "google/fixture-20261023", effort: "low" }];
    expect(observe([event], { modelAliases: { "google/fixture": "google/fixture-20260929" } }).routerCandidate).toMatchObject({ matched: 0, selectedByJev: false });
  });
  it("logs the model names Jev listed, bounded", () => {
    const event = completed(), data = event.response.openrouter_metadata.pipeline[0].data;
    data.candidates = Array.from({ length: 20 }, (_, i) => ({ model: `m/${i}`, effort: "low" }));
    data.resolved_models = ["x/" + "y".repeat(300)];
    const { routerCandidate } = observe([event]);
    expect(routerCandidate.listedCandidates).toHaveLength(8);
    expect(routerCandidate.listedResolved[0]).toHaveLength(200);
  });
  it("retains bounded endpoint evidence when a display-name endpoint fails the served-model guard", () => {
    const event = completed(); const endpoint = event.response.openrouter_metadata.endpoints.available[0];
    endpoint.model = "Vendor: Fixture Pro\u0007"; endpoint.provider = "Vendor AI"; endpoint.tag = "vendor/fast";
    event.response.openrouter_metadata.pipeline[0].data.private_payload = "PRIVATE_SENTINEL";
    const result = observe([event]);
    expect(result).toMatchObject({ error: "conflicting-served-model", provider: null,
      endpointModel: "Vendor: Fixture Pro", endpointProvider: "Vendor AI", endpointTag: "vendor/fast" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    endpoint.model = "m".repeat(300);
    expect(observe([event]).endpointModel).toHaveLength(200);
  });
  it("retains slug endpoint evidence on success and nulls it without a selected endpoint", () => {
    const event = completed(); const endpoint = event.response.openrouter_metadata.endpoints.available[0];
    expect(observe([event])).toMatchObject({ error: null, endpointModel: endpoint.model, endpointProvider: endpoint.provider });
    endpoint.selected = false;
    expect(observe([event])).toMatchObject({ endpointModel: null, endpointProvider: null, endpointTag: null });
  });
  it("does not infer served model or effort from the requested model", () => {
    const event = completed(); event.response.model = "typesafe/jev-router";
    delete event.response.openrouter_metadata.endpoints.available[0].model;
    expect(observe([event])).toMatchObject({ resolvedModel: null, error: "missing-provider-attribution" });
  });
  it.each([
    [{ type: "response.failed", error: { message: "PRIVATE_SENTINEL" } }, "provider-response-failed"],
    [{ type: "response.refusal.done", refusal: "PRIVATE_SENTINEL" }, "provider-refusal"],
    [{ type: "response.output_item.done", item: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: "invalid" } }, "malformed-tool-response"],
  ])("classifies protocol failure without provider content", (event, error) => {
    const result = observe([event, completed()]);
    expect(result.error).toBe(error); expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  });
  it("rejects truncation, malformed JSON, conflicting metadata and repeated completion", () => {
    expect(observe([]).error).toBe("incomplete-response-stream");
    const event = completed(); event.response.openrouter_metadata.endpoints.available[0].model = "other/model";
    expect(observe([event]).error).toBe("conflicting-served-model");
    expect(observe([completed(), completed()]).error).toBe("duplicate-completion");
    const observer = createResponseObserver(); observer.push('data: invalid\n\n');
    expect(observer.finish().error).toBe("malformed-response");
  });
});
