import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveSensitivePathAck,
  resolveAiAck,
  runHeuristics,
  applyAiAck,
  runAiReview,
} from "../scripts/lane-review.mjs";

describe("resolveSensitivePathAck", () => {
  it("neither label nor marker -> not acknowledged, no problem (normal PR)", () => {
    expect(resolveSensitivePathAck({ prBody: "just a normal PR", labels: ["type:fix"] })).toEqual({
      acknowledged: false,
      problem: null,
    });
  });

  it("label without marker -> not acknowledged, names the missing marker", () => {
    const r = resolveSensitivePathAck({ prBody: "no marker here", labels: ["sensitive-path-ack"] });
    expect(r.acknowledged).toBe(false);
    expect(r.problem).toMatch(/lane-review-ack: <reason>/);
  });

  it("marker without label -> not acknowledged, names the missing label", () => {
    const r = resolveSensitivePathAck({ prBody: "lane-review-ack: governance doc update", labels: [] });
    expect(r.acknowledged).toBe(false);
    expect(r.problem).toMatch(/not labeled "sensitive-path-ack"/);
  });

  it("label + marker -> acknowledged with the trimmed reason", () => {
    const r = resolveSensitivePathAck({
      prBody: "context\n\nlane-review-ack:   AGENTS.md promotion policy (MOV-129)  \n\nmore",
      labels: ["type:fix", "sensitive-path-ack"],
    });
    expect(r).toEqual({ acknowledged: true, reason: "AGENTS.md promotion policy (MOV-129)" });
  });
});

describe("runHeuristics sensitive-path gating", () => {
  const ACK = { acknowledged: true, reason: "why" };
  const NO_ACK = { acknowledged: false, problem: null };
  const CLEAN_DIFF = "+ a harmless line\n";

  it("blocks a sensitive-path change with no acknowledgement", () => {
    const findings = runHeuristics(["AGENTS.md"], CLEAN_DIFF, NO_ACK);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("block");
    expect(findings[0].summary).toMatch(/add the "sensitive-path-ack" label/);
  });

  it("downgrades the sensitive-path finding to warn when acknowledged", () => {
    const findings = runHeuristics([".github/workflows/verify.yml"], CLEAN_DIFF, ACK);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].summary).toMatch(/acknowledged/);
  });

  it("surfaces the label/marker mismatch problem in the block message", () => {
    const findings = runHeuristics(["AGENTS.md"], CLEAN_DIFF, {
      acknowledged: false,
      problem: 'labeled "sensitive-path-ack" but the PR body has no "lane-review-ack: <reason>" line',
    });
    expect(findings[0].severity).toBe("block");
    expect(findings[0].summary).toMatch(/PR body has no/);
  });

  it("never downgrades a secret-detection block, even when acknowledged", () => {
    // Build the sk- token at runtime so this file's own source doesn't trip
    // lane-review's secret scanner when this very repo is the PR under review.
    const fakeSecret = `sk-${"x".repeat(30)}`;
    const diffWithSecret = `+ const key = '${fakeSecret}'\n`;
    const findings = runHeuristics(["AGENTS.md"], diffWithSecret, ACK);
    const severities = findings.map((f) => f.severity);
    expect(findings.some((f) => /contain a/.test(f.summary) && f.severity === "block")).toBe(true);
    // sensitive-path itself is a warn now, but the secret keeps it failing
    expect(severities).toContain("block");
  });

  it("is a no-op when no sensitive path is touched", () => {
    const findings = runHeuristics(["src/lib/foo.ts", "test/foo.test.ts"], CLEAN_DIFF, NO_ACK);
    expect(findings).toEqual([]);
  });

  it("still blocks an oversized diff regardless of acknowledgement", () => {
    const hugeDiff = Array.from({ length: 1600 }, (_, i) => `+ line ${i}`).join("\n");
    const findings = runHeuristics(["AGENTS.md"], hugeDiff, ACK);
    expect(findings.some((f) => /scope threshold/.test(f.summary) && f.severity === "block")).toBe(true);
  });
});

describe("resolveAiAck", () => {
  it("neither label nor marker -> not acknowledged, no problem", () => {
    expect(resolveAiAck({ prBody: "a normal PR", labels: ["type:fix"] })).toEqual({
      acknowledged: false,
      problem: null,
    });
  });

  it("label without marker -> not acknowledged, names the missing marker", () => {
    const r = resolveAiAck({ prBody: "no marker", labels: ["lane-review-ai-ack"] });
    expect(r.acknowledged).toBe(false);
    expect(r.problem).toMatch(/lane-review-ai-ack: <reason>/);
  });

  it("marker without label -> not acknowledged, names the missing label", () => {
    const r = resolveAiAck({ prBody: "lane-review-ai-ack: false positive on the loop claim", labels: [] });
    expect(r.acknowledged).toBe(false);
    expect(r.problem).toMatch(/not labeled "lane-review-ai-ack"/);
  });

  it("label + marker -> acknowledged with the trimmed reason", () => {
    const r = resolveAiAck({
      prBody: "context\n\nlane-review-ai-ack:   model misread the await chain (MOV-150)  \n",
      labels: ["type:fix", "lane-review-ai-ack"],
    });
    expect(r).toEqual({ acknowledged: true, reason: "model misread the await chain (MOV-150)" });
  });

  it("uses a marker distinct from the sensitive-path ack marker", () => {
    // A sensitive-path ack line must NOT satisfy the AI ack, and vice versa.
    expect(resolveAiAck({ prBody: "lane-review-ack: something", labels: ["lane-review-ai-ack"] }).acknowledged).toBe(
      false
    );
    expect(
      resolveSensitivePathAck({ prBody: "lane-review-ai-ack: something", labels: ["sensitive-path-ack"] }).acknowledged
    ).toBe(false);
  });
});

describe("applyAiAck", () => {
  const NO_ACK = { acknowledged: false, problem: null };
  const ACK = { acknowledged: true, reason: "confirmed false positive" };
  const MISMATCH = { acknowledged: false, problem: 'labeled "lane-review-ai-ack" but the PR body has no marker' };

  it("passes an ai-skipped warn through untouched", () => {
    const input = [{ severity: "warn", kind: "ai-skipped", summary: "ANTHROPIC_API_KEY not set" }];
    expect(applyAiAck(input, NO_ACK)).toEqual(input);
  });

  it("leaves an ai-model block as block, with an ack hint, when unacknowledged", () => {
    const out = applyAiAck([{ severity: "block", kind: "ai-model", summary: "possible SQL injection" }], NO_ACK);
    expect(out[0].severity).toBe("block");
    expect(out[0].summary).toMatch(/lane-review-ai-ack/);
  });

  it("downgrades an ai-model block to warn when acknowledged, recording the reason", () => {
    const out = applyAiAck([{ severity: "block", kind: "ai-model", summary: "claims an infinite loop" }], ACK);
    expect(out[0].severity).toBe("warn");
    expect(out[0].summary).toMatch(/AI block acknowledged/);
    expect(out[0].summary).toMatch(/confirmed false positive/);
  });

  it("keeps an ai-model block as block and surfaces the label/marker mismatch", () => {
    const out = applyAiAck([{ severity: "block", kind: "ai-model", summary: "scope creep" }], MISMATCH);
    expect(out[0].severity).toBe("block");
    expect(out[0].summary).toMatch(/no marker/);
  });

  it("NEVER downgrades an ai-infra block, even when acknowledged", () => {
    const out = applyAiAck(
      [{ severity: "block", kind: "ai-infra", summary: "AI review pass returned invalid JSON" }],
      ACK
    );
    expect(out[0].severity).toBe("block");
    expect(out[0].summary).toBe("AI review pass returned invalid JSON");
  });

  it("leaves ai-model warns alone regardless of ack", () => {
    const input = [{ severity: "warn", kind: "ai-model", summary: "minor nit" }];
    expect(applyAiAck(input, ACK)).toEqual(input);
  });

  it("does not mutate its input", () => {
    const input = [{ severity: "block", kind: "ai-model", summary: "x" }];
    const snapshot = JSON.parse(JSON.stringify(input));
    applyAiAck(input, ACK);
    expect(input).toEqual(snapshot);
  });
});

describe("runAiReview", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  function fakeFetch(status, body) {
    return async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }

  // MOV-183: the fix under test is switching from free-text "respond with
  // only JSON" + regex-extraction to a forced tool call. These fixtures
  // simulate the Anthropic API's tool_use response shape directly — no real
  // network call, no ANTHROPIC_API_KEY required to run this suite.

  it("ANTHROPIC_API_KEY absent -> ai-skipped warn, unaffected by this fix", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await runAiReview("diff", "title", "body", { fetchFn: fakeFetch(200, {}) });
    expect(result).toEqual({
      ran: false,
      configured: false,
      findings: [
        {
          severity: "warn",
          kind: "ai-skipped",
          summary: "ANTHROPIC_API_KEY not set — AI review pass skipped; heuristic checks only",
        },
      ],
    });
  });

  it("HTTP failure -> non-downgradeable ai-infra block, unaffected by this fix", async () => {
    const result = await runAiReview("diff", "title", "body", {
      fetchFn: fakeFetch(500, { error: "internal error" }),
    });
    expect(result.ran).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("ai-infra");
    expect(result.findings[0].severity).toBe("block");
    expect(result.findings[0].summary).toMatch(/HTTP 500/);
  });

  it("well-formed tool_use response with block + warn findings parses both correctly", async () => {
    const apiResponse = {
      content: [
        {
          type: "tool_use",
          name: "report_findings",
          input: {
            findings: [
              { severity: "block", summary: "hardcoded credential in config" },
              { severity: "warn", summary: "minor naming nit" },
            ],
          },
        },
      ],
    };
    const result = await runAiReview("diff", "title", "body", { fetchFn: fakeFetch(200, apiResponse) });
    expect(result.ran).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.findings).toEqual([
      { severity: "block", kind: "ai-model", summary: "hardcoded credential in config" },
      { severity: "warn", kind: "ai-model", summary: "minor naming nit" },
    ]);
  });

  it("empty findings array (clean diff) parses to no findings", async () => {
    const apiResponse = {
      content: [{ type: "tool_use", name: "report_findings", input: { findings: [] } }],
    };
    const result = await runAiReview("diff", "title", "body", { fetchFn: fakeFetch(200, apiResponse) });
    expect(result.ran).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("no tool_use content block at all -> non-downgradeable ai-infra block, not a crash", async () => {
    const apiResponse = { content: [{ type: "text", text: "I refuse to use the tool." }] };
    const result = await runAiReview("diff", "title", "body", { fetchFn: fakeFetch(200, apiResponse) });
    expect(result.ran).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("ai-infra");
    expect(result.findings[0].severity).toBe("block");
    expect(result.findings[0].summary).toMatch(/did not return a structured findings report/);
  });

  it("empty content array -> non-downgradeable ai-infra block, not a crash", async () => {
    const result = await runAiReview("diff", "title", "body", { fetchFn: fakeFetch(200, { content: [] }) });
    expect(result.findings[0].kind).toBe("ai-infra");
    expect(result.findings[0].severity).toBe("block");
  });

  it("a malformed finding entry (missing summary, or a bad severity) is filtered out, not passed through", async () => {
    const apiResponse = {
      content: [
        {
          type: "tool_use",
          name: "report_findings",
          input: {
            findings: [
              { severity: "block", summary: "real finding" },
              { severity: "critical", summary: "not a valid severity" },
              { severity: "warn" },
            ],
          },
        },
      ],
    };
    const result = await runAiReview("diff", "title", "body", { fetchFn: fakeFetch(200, apiResponse) });
    expect(result.findings).toEqual([{ severity: "block", kind: "ai-model", summary: "real finding" }]);
  });

  it("sends tool_choice forcing the report_findings tool, not free-text prompting", async () => {
    let capturedBody = null;
    const fetchFn = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "tool_use", name: "report_findings", input: { findings: [] } }] }),
      };
    };
    await runAiReview("diff", "title", "body", { fetchFn });
    expect(capturedBody.tool_choice).toEqual({ type: "tool", name: "report_findings" });
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tools[0].name).toBe("report_findings");
  });
});
