import { describe, it, expect } from "vitest";
import { DESIRED_PROJECTS, RETIRED_PROJECTS } from "../src/linear-topology.mjs";
import {
  CLOUD_PROJECTS,
  EXECUTION_LABELS,
  MAC_PROJECTS,
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
    for (const project of ["Shared Watchlists Core & API", "Web Shared Watchlists", "iOS Shared Watchlists"]) {
      expect(inferExecutionRoute({ project })).toBe("mac");
      expect(resolveExecutionRoute({ project, labels: ["execution:mac"] })).toMatchObject({ ok: true, route: "mac" });
    }
    expect(inferExecutionRoute({ project: "Autonomous local-agent delivery" })).toBe("mac");
    expect(inferExecutionRoute({ project: "Local development workflow stabilization and governance" })).toBe("mac");
  });

  it("routes every desired active project and no retired project", () => {
    const roster = new Set([...MAC_PROJECTS, ...CLOUD_PROJECTS]);
    for (const { name } of DESIRED_PROJECTS) expect(roster.has(name)).toBe(true);
    for (const name of RETIRED_PROJECTS) expect(roster.has(name)).toBe(false);
    // Mac/cloud separation is intact: no project is on both sides.
    for (const name of CLOUD_PROJECTS) expect(MAC_PROJECTS.has(name)).toBe(false);
    for (const { name } of DESIRED_PROJECTS) {
      expect(inferExecutionRoute({ project: name })).toBe(CLOUD_PROJECTS.has(name) ? "cloud" : "mac");
    }
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
    expect(resolveExecutionRoute({ project: "Shared Watchlists Core & API", labels: ["execution:none"] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/reserved/),
    });
  });

  it("rejects crossing the active local and deferred-cloud project boundaries", () => {
    for (const project of ["Shared Watchlists Core & API", "Web Shared Watchlists", "iOS Shared Watchlists"]) {
      expect(resolveExecutionRoute({ project, labels: ["execution:cloud"] })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/cannot use execution:cloud/),
      });
    }
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
