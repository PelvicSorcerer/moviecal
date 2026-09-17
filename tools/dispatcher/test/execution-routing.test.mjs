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

  it("defaults active product, local-delivery, and Mac-only work to Mac", () => {
    expect(inferExecutionRoute({ project: "iOS Companion App" })).toBe("mac");
    expect(inferExecutionRoute({ project: "Platform & Infrastructure", title: "Update xcodebuild lane" })).toBe("mac");
    expect(inferExecutionRoute({ project: "Shared Watchlists" })).toBe("mac");
    expect(inferExecutionRoute({ project: "Calendar Feed" })).toBe("mac");
    expect(inferExecutionRoute({ project: "Autonomous local-agent delivery" })).toBe("mac");
    expect(inferExecutionRoute({ project: "Local development workflow stabilization and governance" })).toBe("mac");
  });

  it("infers cloud only for the separately deferred cloud project", () => {
    expect(inferExecutionRoute({ project: "Deferred Linear cloud execution option" })).toBe("cloud");
  });

  it("falls back to Mac when the issue is ambiguous", () => {
    expect(inferExecutionRoute({ title: "Investigate the right approach" })).toBe("mac");
  });

  it("preserves either explicit execution adapter when reading the completed mixed-route project", () => {
    const project = "Hybrid workflow foundations (completed)";
    expect(inferExecutionRoute({ project })).toBe("mac");
    expect(resolveExecutionRoute({ project, labels: ["execution:cloud"] })).toMatchObject({
      ok: true,
      route: "cloud",
    });
    expect(resolveExecutionRoute({ project, labels: ["execution:mac"] })).toMatchObject({
      ok: true,
      route: "mac",
    });
  });

  it("still rejects cloud routing for Mac-only work in the mixed hybrid project", () => {
    expect(
      resolveExecutionRoute({
        project: "Hybrid workflow foundations (completed)",
        title: "Validate an Xcode simulator workflow",
        labels: ["execution:cloud"],
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot use execution:cloud/),
    });
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
    expect(resolveExecutionRoute({ project: "Deferred Linear cloud execution option" })).toMatchObject({
      ok: false,
      materialized: false,
      inferred: "cloud",
      reason: expect.stringMatching(/missing execution label/),
    });
  });

  it("rejects execution:none on an executable issue", () => {
    expect(resolveExecutionRoute({ project: "Shared Watchlists", labels: ["execution:none"] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/reserved/),
    });
  });

  it("rejects crossing the active local and deferred-cloud project boundaries", () => {
    expect(resolveExecutionRoute({ project: "Shared Watchlists", labels: ["execution:cloud"] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot use execution:cloud/),
    });
    expect(
      resolveExecutionRoute({ project: "Deferred Linear cloud execution option", labels: ["execution:mac"] }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/deferred cloud project/),
    });
  });

  it("rejects a cloud override for iOS/Xcode work", () => {
    expect(resolveExecutionRoute({ project: "iOS Companion App", labels: ["execution:cloud"] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot use execution:cloud/),
    });
  });
});
