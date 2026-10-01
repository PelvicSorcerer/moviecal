import { describe, expect, it } from "vitest";
import { createResponseObserver } from "../src/openrouter-response.mjs";

const completed = () => ({ type: "response.completed", response: {
  id: "gen-fixture", model: "google/fixture", reasoning: { effort: "low" },
  usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 10 }, cost: 0.002 },
  openrouter_metadata: { attempt: 1, pipeline: [{ name: "jev-router", data: { reasoning_effort: "low" } }], endpoints: { available: [{ model: "google/fixture", provider: "Google", selected: true }] } },
} });
function observe(events) {
  const observer = createResponseObserver();
  const bytes = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  for (let offset = 0; offset < bytes.length; offset += 7) observer.push(bytes.subarray(offset, offset + 7));
  return observer.finish();
}
describe("OpenRouter Responses evidence", () => {
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
