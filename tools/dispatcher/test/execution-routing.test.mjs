import { describe, it, expect } from "vitest";
import {
  EXECUTION_LABELS,
  inferExecutionRoute,
  isCoordinationIssue,
  parseExecutionLabels,
  resolveExecutionRoute,
} from "../src/execution-routing.mjs";

describe("execution routing", () => {
  it("parses only the three known route labels", () => {
    expect(parseExecutionLabels(["area:process", ...EXECUTION_LABELS, "execution:other"])).toEqual(EXECUTION_LABELS);
  });

  it("rejects conflicting materialized routes", () => {
    expect(resolveExecutionRoute({ labels: ["execution:mac", "execution:cloud"] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/multiple/),
    });
  });

  it("defaults iOS Companion App and Xcode work to Mac", () => {
    expect(inferExecutionRoute({ project: "iOS Companion App" })).toBe("mac");
    expect(inferExecutionRoute({ project: "Platform & Infrastructure", title: "Update xcodebuild lane" })).toBe("mac");
  });

  it("infers cloud for a supported non-iOS project", () => {
    expect(inferExecutionRoute({ project: "Calendar Feed", title: "Add release filter" })).toBe("cloud");
  });

  it("falls back to Mac when the issue is ambiguous", () => {
    expect(inferExecutionRoute({ title: "Investigate the right approach" })).toBe("mac");
  });

  it("infers coordination parents as none", () => {
    const issue = { labels: ["type:coordination"] };
    expect(isCoordinationIssue(issue)).toBe(true);
    expect(inferExecutionRoute(issue)).toBe("none");
    expect(resolveExecutionRoute({ ...issue, labels: [...issue.labels, "execution:none"] })).toMatchObject({
      ok: true,
      route: "none",
    });
  });

  it("requires the inferred route to be materialized", () => {
    expect(resolveExecutionRoute({ project: "Calendar Feed" })).toMatchObject({
      ok: false,
      materialized: false,
      inferred: "cloud",
      reason: expect.stringMatching(/missing execution label/),
    });
  });

  it("rejects execution:none on an executable issue", () => {
    expect(resolveExecutionRoute({ project: "Calendar Feed", labels: ["execution:none"] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/reserved/),
    });
  });

  it("rejects a cloud override for iOS/Xcode work", () => {
    expect(resolveExecutionRoute({ project: "iOS Companion App", labels: ["execution:cloud"] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot use execution:cloud/),
    });
  });
});
