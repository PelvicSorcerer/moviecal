import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  decideCiOutcome,
  failureFingerprint,
  formatShadowReport,
  idempotencyKey,
  linearObservationStatus,
  reportObservationToLinear,
} from "../src/ci-outcomes.mjs";

describe("classifyFailure", () => {
  it.each([
    [{ name: "lane-unit", conclusion: "FAILURE", message: "expect(received).toBe(expected)" }, "code-test"],
    [{ name: "lane-baseline", conclusion: "TIMED_OUT" }, "infrastructure-transient"],
    [{ name: "deploy", conclusion: "FAILURE", message: "HTTP 503 from runner" }, "infrastructure-transient"],
    [{ name: "verify", conclusion: "FAILURE", message: "403 forbidden: token expired" }, "sensitive-permission"],
    [{ name: "mystery-check", conclusion: "FAILURE", message: "something went wrong" }, "unknown"],
    [{ name: "lane-unit", conclusion: "SUCCESS" }, "non-actionable"],
  ])("classifies %j as %s", (event, expected) => {
    expect(classifyFailure(event).classification).toBe(expected);
  });
});

describe("decideCiOutcome", () => {
  const base = { prNumber: 148, headSha: "abc123", budgets: { codeRepair: 1, infrastructureRerun: 2, total: 3 } };

  it("deduplicates repeated events and groups multiple failures into one repair", () => {
    const event = { name: "lane-unit", sha: "abc123", conclusion: "FAILURE", message: "expect failed" };
    const result = decideCiOutcome({ ...base, events: [event, event, { ...event, detailsUrl: "later" }, { name: "lane-baseline", sha: "abc123", conclusion: "FAILURE", message: "TypeScript compile failed" }] });
    expect(result.uniqueEventCount).toBe(2);
    expect(result.groupedFailureCount).toBe(2);
    expect(result.action).toBe("propose-code-repair");
    expect(result.repairKey).toBe("repair:148:abc123");
  });

  it("is stable when events are repeated or reordered", () => {
    const events = [
      { name: "infra", sha: "abc123", conclusion: "FAILURE", message: "503 service unavailable" },
      { name: "unit", sha: "abc123", conclusion: "SUCCESS" },
    ];
    const a = decideCiOutcome({ ...base, events });
    const b = decideCiOutcome({ ...base, events: [events[1], events[0], events[0]] });
    expect(b.idempotencyKeys).toEqual(a.idempotencyKeys);
    expect(b.action).toBe(a.action);
  });

  it("escalates sensitive, unknown, and conflicting outcomes", () => {
    expect(decideCiOutcome({ ...base, events: [{ name: "deploy", conclusion: "FAILURE", message: "permission denied" }] }).action).toBe("escalate");
    expect(decideCiOutcome({ ...base, events: [
      { name: "mystery", conclusion: "FAILURE", message: "opaque failure" },
      { name: "mystery", conclusion: "ERROR", message: "different opaque failure" },
    ] }).action).toBe("escalate");
  });

  it("honors repair, rerun, and total attempt budgets", () => {
    const code = { name: "unit", conclusion: "FAILURE", message: "test failed" };
    expect(decideCiOutcome({ ...base, events: [code], previousAttempts: { codeRepair: 1 } }).action).toBe("escalate");
    const infra = { name: "runner", conclusion: "TIMED_OUT" };
    expect(decideCiOutcome({ ...base, events: [infra], previousAttempts: { infrastructureRerun: 2 } }).action).toBe("escalate");
    expect(decideCiOutcome({ ...base, events: [infra], previousAttempts: { total: 2 } }).action).toBe("propose-infrastructure-rerun");
    expect(decideCiOutcome({ ...base, events: [infra], previousAttempts: { total: 3 } }).action).toBe("escalate");
  });
});

describe("idempotency and shadow output", () => {
  it("uses PR, current head, and failure fingerprint", () => {
    expect(idempotencyKey({ prNumber: 1, headSha: "sha", failureFingerprint: "fp" })).toBe("ci:1:sha:fp");
    expect(failureFingerprint({ name: "unit", conclusion: "FAILURE", message: "failed at 123" })).toMatch(/^[a-f0-9]{24}$/);
  });

  it("makes the no-side-effect contract explicit", () => {
    const report = JSON.parse(formatShadowReport(decideCiOutcome({ prNumber: 1, headSha: "sha", events: [] })));
    expect(report).toMatchObject({ mode: "shadow", readOnly: true, wouldStartWorker: false, wouldRerunCi: false, wouldMutateLinear: false });
  });

  it("publishes a concise idempotent status record without control syntax", async () => {
    const decision = decideCiOutcome({ prNumber: 1, headSha: "sha", events: [{ name: "unit", conclusion: "FAILURE", message: "test failed" }] });
    const client = { calls: [], addComment: async (id, body) => client.calls.push({ id, body }) };
    const first = await reportObservationToLinear({ linearClient: client, issueId: "linear-1", decision, observation: { requiredChecks: ["unit"] } });
    const second = await reportObservationToLinear({ linearClient: client, issueId: "linear-1", decision, observation: {}, existingBodies: [client.calls[0].body] });
    expect(first.reported).toBe(true);
    expect(second.reported).toBe(false);
    expect(client.calls[0].body).toContain("CI observation (read-only)");
    expect(linearObservationStatus({ decision, observation: {} })).not.toContain("/project-update");
  });
});
