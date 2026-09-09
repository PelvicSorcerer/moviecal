import { describe, it, expect } from "vitest";
import { resolveSensitivePathAck, runHeuristics } from "../scripts/lane-review.mjs";

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
