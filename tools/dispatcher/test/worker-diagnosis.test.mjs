import { describe, it, expect, vi } from "vitest";
import { diagnoseUnrecognizedFailure } from "../src/worker-diagnosis.mjs";

function toolUseResponse(input) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "report_diagnosis", input }],
    }),
  };
}

describe("diagnoseUnrecognizedFailure", () => {
  it("returns a grounded, confident diagnosis when the model names a specific signature", async () => {
    const fetchFn = vi.fn(async () =>
      toolUseResponse({
        confident: true,
        diagnosis: "The worker's provider call returned api_error_status 529 (overloaded).",
        evidence: '"api_error_status":529',
      }),
    );

    const result = await diagnoseUnrecognizedFailure({
      exitCode: 1,
      logTail: '{"type":"error","error":{"api_error_status":529}}',
      auditText: "{}",
      apiKey: "sk-test",
      fetchFn,
    });

    expect(result).toEqual({
      ok: true,
      confident: true,
      diagnosis: "The worker's provider call returned api_error_status 529 (overloaded).",
      evidence: '"api_error_status":529',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns explicit uncertainty rather than a fabricated cause when the model is not confident", async () => {
    const fetchFn = vi.fn(async () =>
      toolUseResponse({
        confident: false,
        diagnosis: "No specific error signature is present in the available evidence; cannot confidently identify a cause.",
      }),
    );

    const result = await diagnoseUnrecognizedFailure({
      exitCode: 1,
      logTail: "",
      auditText: "",
      apiKey: "sk-test",
      fetchFn,
    });

    expect(result.ok).toBe(true);
    expect(result.confident).toBe(false);
    expect(result.diagnosis).toMatch(/cannot confidently identify/i);
    expect(result.evidence).toBeNull();
  });

  it("bounds the request to one call with no retry when the API returns an error status", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, text: async () => "internal error" }));

    const result = await diagnoseUnrecognizedFailure({
      exitCode: 1,
      logTail: "boom",
      apiKey: "sk-test",
      fetchFn,
    });

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("HTTP 500") });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back safely when the fetch call itself throws (network error / timeout)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network unreachable");
    });

    const result = await diagnoseUnrecognizedFailure({
      exitCode: 1,
      logTail: "boom",
      apiKey: "sk-test",
      fetchFn,
    });

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("network unreachable") });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back safely when the response has no usable tool_use block", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "not structured" }] }) }));

    const result = await diagnoseUnrecognizedFailure({ exitCode: 1, logTail: "boom", apiKey: "sk-test", fetchFn });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/structured report/);
  });

  it("falls back safely when the response body is not valid JSON", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }));

    const result = await diagnoseUnrecognizedFailure({ exitCode: 1, logTail: "boom", apiKey: "sk-test", fetchFn });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not valid JSON/);
  });

  it("skips the call entirely and reports not-configured when no API key is available", async () => {
    const fetchFn = vi.fn();

    const result = await diagnoseUnrecognizedFailure({ exitCode: 1, logTail: "boom", apiKey: undefined, fetchFn });

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("bounds the log tail sent to the model rather than forwarding an unbounded transcript", async () => {
    let capturedBody;
    const fetchFn = vi.fn(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return toolUseResponse({ confident: false, diagnosis: "no signature found" });
    });

    const hugeLog = "x".repeat(50_000);
    await diagnoseUnrecognizedFailure({ exitCode: 1, logTail: hugeLog, apiKey: "sk-test", fetchFn });

    const userMessage = capturedBody.messages[0].content;
    expect(userMessage.length).toBeLessThan(hugeLog.length);
    expect(capturedBody.max_tokens).toBeLessThanOrEqual(1024);
  });

  it("redacts credential-shaped material from the log tail before it is sent to the model", async () => {
    let capturedBody;
    const fetchFn = vi.fn(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return toolUseResponse({ confident: false, diagnosis: "no signature found" });
    });

    const secretToken = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    await diagnoseUnrecognizedFailure({
      exitCode: 1,
      logTail: `Authorization failed using token ${secretToken}`,
      apiKey: "sk-test",
      fetchFn,
    });

    const userMessage = capturedBody.messages[0].content;
    expect(userMessage).not.toContain(secretToken);
    expect(userMessage).toContain("[REDACTED]");
  });

  it("redacts credential-shaped material from the audit text as well as the log tail", async () => {
    let capturedBody;
    const fetchFn = vi.fn(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return toolUseResponse({ confident: false, diagnosis: "no signature found" });
    });

    await diagnoseUnrecognizedFailure({
      exitCode: 1,
      logTail: "ordinary log",
      auditText: "PRIVATE_KEY=super-secret-value-here",
      apiKey: "sk-test",
      fetchFn,
    });

    const userMessage = capturedBody.messages[0].content;
    expect(userMessage).not.toContain("super-secret-value-here");
  });

  it("sends a forced tool_choice so the model cannot return free-text prose instead", async () => {
    let capturedBody;
    const fetchFn = vi.fn(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return toolUseResponse({ confident: false, diagnosis: "no signature found" });
    });

    await diagnoseUnrecognizedFailure({ exitCode: 1, logTail: "boom", apiKey: "sk-test", fetchFn });

    expect(capturedBody.tool_choice).toEqual({ type: "tool", name: "report_diagnosis" });
  });
});
