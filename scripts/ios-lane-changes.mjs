// Decide whether a push needs the expensive self-hosted iOS verification lane.
//
// The workflow always reports `lane-ios`, so it can safely become a required
// status check. This script decides whether that job consumes the Mac runner.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import branchCiConventions from "../docs/operators/branch-prefixes.json" with { type: "json" };

export const IOS_LANE_RELEVANT_PATHS = Object.freeze(
  branchCiConventions.conditionalSelfHostedPaths[".github/workflows/ios-verify.yml"],
);

const ZERO_SHA = /^0+$/;
const SHA = /^[0-9a-f]{40}$/i;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function isUsableBeforeSha(before) {
  return typeof before === "string" && SHA.test(before) && !ZERO_SHA.test(before);
}

export function isIosLaneRelevantPath(file) {
  return typeof file === "string" && (
    file.startsWith("ios/") || IOS_LANE_RELEVANT_PATHS.slice(1).includes(file)
  );
}

export function shouldRunIosLane(changedPaths) {
  return changedPaths.some(isIosLaneRelevantPath);
}

function existingCommit(ref, runGit) {
  try {
    runGit(["cat-file", "-e", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer GitHub's `before` SHA for an ordinary push. A new branch reports the
 * all-zero SHA, so compare that branch's HEAD with its merge base on master.
 */
export function comparisonBase({ before, baseRef = "origin/master", runGit = git } = {}) {
  if (isUsableBeforeSha(before) && existingCommit(before, runGit)) {
    return { ref: before, source: "before" };
  }

  const mergeBase = runGit(["merge-base", "HEAD", baseRef]).trim();
  if (!mergeBase) throw new Error(`could not resolve a merge base with ${baseRef}`);
  return { ref: mergeBase, source: "merge-base" };
}

export function determineIosLane({ before, baseRef = "origin/master", runGit = git } = {}) {
  const base = comparisonBase({ before, baseRef, runGit });
  const changedPaths = runGit(["diff", "--name-only", base.ref, "HEAD"])
    .split("\n")
    .filter(Boolean);
  return { ...base, changedPaths, shouldRun: shouldRunIosLane(changedPaths) };
}

function isMainModule() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const result = determineIosLane({ before: process.env.BEFORE });
  console.log(`should_run=${result.shouldRun}`);
  console.log(`comparison_source=${result.source}`);
}
