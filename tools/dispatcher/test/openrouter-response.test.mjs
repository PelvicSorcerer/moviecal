import { describe, expect, it } from "vitest";
import { createResponseObserver } from "../src/openrouter-response.mjs";

const completed = () => ({ type: "response.completed", response: {
  id: "gen-fixture", model: "google/fixture", reasoning: { effort: "low" },
  usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 10 }, cost: 0.002 },
  openrouter_metadata: { attempt: 1, pipeline: [{ name: "jev-router", data: { reasoning_effort: "low" } }], endpoints: { available: [{ model: "google/fixture", provider: "Google", selected: true }] } },
} });
function observe(events, options) {
  const observer = createResponseObserver(options);
  const bytes = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  for (let offset = 0; offset < bytes.length; offset += 7) observer.push(bytes.subarray(offset, offset + 7));
  return observer.finish();
}
describe("OpenRouter Responses evidence", () => {
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
    expect(observe([event]).error).toBe("conflicting-served-model");
    event.response.openrouter_metadata.endpoints.available[0].model = "google/fixture-20260928";
    expect(observe([event], options).error).toBe("conflicting-served-model");
  });
  it("reports a missing effort after alias normalization and saves only router field names", () => {
    const event = completed();
    event.response.openrouter_metadata.endpoints.available[0].model = "google/fixture-20260929";
    event.response.openrouter_metadata.pipeline[0].data = { resolved_models: ["google/fixture"], private_payload: "PRIVATE_SENTINEL" };
    const result = observe([event], { modelAliases: { "google/fixture": "google/fixture-20260929" } });
    expect(result).toMatchObject({ resolvedEffort: null, error: "missing-provider-attribution", routerStageKeys: ["resolved_models", "private_payload"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
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
