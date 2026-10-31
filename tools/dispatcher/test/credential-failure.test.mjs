import { describe, it, expect } from "vitest";
import { CREDENTIAL_FAILURE, classifyCredentialFailure } from "../src/credential-failure.mjs";

describe("classifyCredentialFailure", () => {
  it("recognizes the structured api_error_status: 401 field", () => {
    const result = classifyCredentialFailure({
      exitCode: 1,
      logTail: '{"type":"error","error":{"api_error_status":401,"message":"..."}}',
    });
    expect(result).toMatchObject({ category: CREDENTIAL_FAILURE });
    expect(result.evidence).toContain("401");
  });

  it("recognizes the structured authentication_failed error code", () => {
    const result = classifyCredentialFailure({
      exitCode: 1,
      logTail: '{"type":"error","error":"authentication_failed","message":"invalid x-api-key"}',
    });
    expect(result).toMatchObject({ category: CREDENTIAL_FAILURE });
  });

  it("recognizes the literal production incident message (MOV-172/173/175)", () => {
    const result = classifyCredentialFailure({
      exitCode: 1,
      logTail: "401 OAuth access token has expired. Re-authenticate to continue.",
    });
    expect(result).toMatchObject({ category: CREDENTIAL_FAILURE });
    expect(result.evidence).toMatch(/OAuth access token has expired/i);
  });

  it("recognizes an invalid API key signature (MOV-176's future credential path)", () => {
    const result = classifyCredentialFailure({
      exitCode: 1,
      logTail: "Error: Invalid API Key provided",
    });
    expect(result).toMatchObject({ category: CREDENTIAL_FAILURE });
  });

  it("returns null for a zero exit — the worker ran, so this is never a credential failure", () => {
    expect(
      classifyCredentialFailure({ exitCode: 0, logTail: "401 OAuth access token has expired." }),
    ).toBeNull();
  });

  it("returns null for an ordinary task failure with no auth-failure signature", () => {
    expect(
      classifyCredentialFailure({ exitCode: 1, logTail: "TypeError: cannot read property of undefined" }),
    ).toBeNull();
  });

  it("returns null for a provider usage/rate-limit message — a distinct, unrelated failure class", () => {
    expect(
      classifyCredentialFailure({
        exitCode: 1,
        logTail: "Claude AI usage limit reached|1757894400",
      }),
    ).toBeNull();
  });

  it("does not fire on an unrelated bare 401 in ordinary test/app output (not a false positive)", () => {
    // e.g. a legitimate auth-gate integration test asserting a 401 response —
    // this must not trip a dispatcher-wide breaker just because "401" appears.
    expect(
      classifyCredentialFailure({
        exitCode: 1,
        logTail: "expect(response.status).toBe(401) // FAIL: received 500\n1 test failed",
      }),
    ).toBeNull();
  });

  it("does not fire on the nested-sandbox-crash signature — a distinct host-wide failure class", () => {
    expect(
      classifyCredentialFailure({
        exitCode: 71,
        logTail: "sandbox-exec: sandbox_apply: Operation not permitted",
      }),
    ).toBeNull();
  });

  it("does not fire when a signature is only quoted inside tool output (doc-quote regression)", () => {
    // MOV-443: a worker ran `rg` over docs/operators and the command output
    // quoted `api_error_status: 401` as an example. That is not a login failure.
    const docQuote = "docs/operators/local-execution.md:339: ... an `api_error_status: 401`, a structured `\"error\": \"authentication_failed\"`, the literal `OAuth access token has expired` message";
    const logTail = [
      "--- stdout.log (last 50 lines) ---",
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg api_error_status docs/operators", aggregated_output: docQuote, exit_code: 0 } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: docQuote }] } }),
      "--- stderr.log (last 50 lines) ---",
      "",
    ].join("\n");
    expect(classifyCredentialFailure({ exitCode: 1, logTail })).toBeNull();
  });

  it("recognizes a Claude result error event carrying api_error_status 401", () => {
    const logTail = JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "Failed to authenticate" });
    expect(classifyCredentialFailure({ exitCode: 1, logTail })).toMatchObject({ category: CREDENTIAL_FAILURE });
  });

  it("recognizes a Codex error event with an expired-token message", () => {
    const logTail = JSON.stringify({ type: "error", message: "401 OAuth access token has expired." });
    expect(classifyCredentialFailure({ exitCode: 1, logTail })).toMatchObject({ category: CREDENTIAL_FAILURE });
  });

  it("handles a missing/undefined logTail without throwing", () => {
    expect(classifyCredentialFailure({ exitCode: 1 })).toBeNull();
    expect(classifyCredentialFailure({ exitCode: 1, logTail: undefined })).toBeNull();
  });
});
