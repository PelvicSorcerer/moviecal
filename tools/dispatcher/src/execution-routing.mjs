// Execution-adapter routing (MOV-142).
//
// The route is deliberately separate from worker/model routing: it answers
// where an issue may execute, not which binary should implement it.

export const EXECUTION_ROUTES = ["cloud", "mac", "none"];
export const EXECUTION_LABELS = EXECUTION_ROUTES.map((route) => `execution:${route}`);
export const EXECUTION_LABEL_GROUP = "execution";

const EXECUTION_LABEL_RE = /^execution:(cloud|mac|none)$/;
const IOS_OR_XCODE_RE = /\b(?:ios|xcode|xcodebuild|simulator)\b|\bself-hosted\s+macos?\s+runner\b|\blocal\s+secret\b/i;
const COORDINATION_LABELS = new Set(["type:coordination", "coordination", "umbrella"]);
const MAC_PROJECTS = new Set([
  "Shared Watchlists",
  "Calendar Feed",
  "Platform & Infrastructure",
  "iOS Companion App",
  "Autonomous local-agent delivery",
  // Completed history remains Mac-only if an old issue is ever re-read.
  "Local development workflow stabilization and governance",
]);
const CLOUD_PROJECTS = new Set(["Deferred Linear cloud execution option"]);
const MIXED_ROUTE_PROJECTS = new Set([
  // Retained aliases for completed history. New work must not be assigned here.
  "Hybrid workflow foundations (completed)",
  "Hybrid Linear cloud + Mac workflow",
]);

function requiresMac(issue = {}) {
  const text = `${issue.title || ""}\n${issue.description || ""}`;
  return MAC_PROJECTS.has(issue.project) || IOS_OR_XCODE_RE.test(text);
}

/** Return only valid execution labels, preserving their order. */
export function parseExecutionLabels(labels = []) {
  return labels.filter((label) => EXECUTION_LABEL_RE.test(label));
}

/**
 * Infer the route that should be materialized on an issue.
 *
 * Coordination issues never execute. iOS/Xcode, runner, and local-secret work
 * is Mac-only. The active product and local-delivery projects run on the Mac;
 * only the separately deferred cloud project infers cloud. Anything ambiguous
 * falls back to Mac until a human clarifies it.
 */
export function inferExecutionRoute(issue = {}) {
  const labels = issue.labels || [];

  if (labels.some((label) => COORDINATION_LABELS.has(label))) return "none";
  if (requiresMac(issue)) return "mac";
  if (CLOUD_PROJECTS.has(issue.project)) return "cloud";
  // Missing routes fail validation, and Mac remains the safe inference until
  // an explicit route is materialized.
  return "mac";
}

/**
 * Validate a materialized route. Returns `ok: false` for a missing, multiple,
 * or semantically-mismatched label — inference is advisory and does not
 * satisfy this. Callers decide whether to enforce the result: MOV-142 uses it
 * only for `dispatcher dry-run` output; MOV-143 makes it a dispatch gate.
 */
export function resolveExecutionRoute(issue = {}) {
  const labels = parseExecutionLabels(issue.labels || []);
  const inferred = inferExecutionRoute(issue);

  if (labels.length > 1) {
    return { ok: false, route: null, inferred, materialized: false, reason: `multiple execution labels: ${labels.join(", ")}` };
  }
  if (labels.length === 0) {
    return { ok: false, route: null, inferred, materialized: false, reason: `missing execution label (inferred ${inferred})` };
  }

  const route = labels[0].slice("execution:".length);
  const mixedRouteProject = MIXED_ROUTE_PROJECTS.has(issue.project);
  if (route === "cloud" && (requiresMac(issue) || (inferred === "mac" && !mixedRouteProject))) {
    return { ok: false, route, inferred, materialized: true, reason: "iOS/Xcode/local-secret work cannot use execution:cloud" };
  }
  if (route === "mac" && CLOUD_PROJECTS.has(issue.project)) {
    return {
      ok: false,
      route,
      inferred,
      materialized: true,
      reason: "deferred cloud project work must use execution:cloud or move to the project that owns local delivery",
    };
  }
  if (route === "none" && inferred !== "none") {
    return { ok: false, route, inferred, materialized: true, reason: "execution:none is reserved for coordination issues" };
  }
  if (inferred === "none" && route !== "none") {
    return { ok: false, route, inferred, materialized: true, reason: "coordination issues must use execution:none" };
  }
  return { ok: true, route, inferred, materialized: true, reason: null };
}

export function isCoordinationIssue(issue = {}) {
  return inferExecutionRoute(issue) === "none";
}
