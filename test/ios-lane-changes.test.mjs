import { describe, expect, it } from "vitest";
import {
  comparisonBase,
  determineIosLane,
  isUsableBeforeSha,
  shouldRunIosLane,
} from "../scripts/ios-lane-changes.mjs";

const BEFORE = "a".repeat(40);
const MERGE_BASE = "b".repeat(40);

function gitFor({ changedPaths = [], beforeExists = true } = {}) {
  return (args) => {
    if (args[0] === "cat-file") {
      if (!beforeExists) throw new Error("missing commit");
      return "";
    }
    if (args[0] === "merge-base") return MERGE_BASE;
    if (args[0] === "diff") return changedPaths.join("\n");
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

describe("ios-lane change detection", () => {
  it.each([
    ["an iOS-only diff", ["ios/Moviecal/App.swift"], true],
    ["a web-only diff", ["src/app/page.tsx"], false],
    ["the iOS workflow", [".github/workflows/ios-verify.yml"], true],
    ["a mixed diff", ["src/app/page.tsx", "ios/Moviecal/App.swift"], true],
  ])("runs for %s only when iOS-relevant", (_name, changedPaths, expected) => {
    expect(shouldRunIosLane(changedPaths)).toBe(expected);
  });

  it("uses the push before SHA when it is an available commit", () => {
    expect(comparisonBase({ before: BEFORE, runGit: gitFor() })).toEqual({ ref: BEFORE, source: "before" });
  });

  it("uses the merge base with master for a new branch with no usable before SHA", () => {
    const result = determineIosLane({
      before: "0".repeat(40),
      runGit: gitFor({ changedPaths: ["ios/Moviecal/App.swift"] }),
    });
    expect(result).toMatchObject({ ref: MERGE_BASE, source: "merge-base", shouldRun: true });
  });

  it("falls back to the merge base when a non-zero before SHA is unavailable locally", () => {
    expect(comparisonBase({ before: BEFORE, runGit: gitFor({ beforeExists: false }) })).toEqual({
      ref: MERGE_BASE,
      source: "merge-base",
    });
  });

  it.each([undefined, "", "not-a-sha", "0".repeat(40)])("rejects an unusable before SHA", (before) => {
    expect(isUsableBeforeSha(before)).toBe(false);
  });
});
