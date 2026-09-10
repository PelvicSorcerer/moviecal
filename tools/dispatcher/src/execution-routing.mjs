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
const CLOUD_PROJECTS = new Set([
  "Shared Watchlists",
  "Calendar Feed",
  "Platform & Infrastructure",
  "Developer Governance & Agent Infrastructure",
]);

/** Return only valid execution labels, preserving their order. */
export function parseExecutionLabels(labels = []) {
  return labels.filter((label) => EXECUTION_LABEL_RE.test(label));
}

/**
 * Infer the route that should be materialized on an issue.
 *
 * Coordination issues never execute. iOS/Xcode, runner, and local-secret work
 * is Mac-only. Known non-iOS projects are cloud-eligible. Anything ambiguous
 * falls back to Mac until a human clarifies it.
 */
export function inferExecutionRoute(issue = {}) {
  const labels = issue.labels || [];
  const text = `${issue.title || ""}\n${issue.description || ""}`;

  if (labels.some((label) => COORDINATION_LABELS.has(label))) return "none";
  if (issue.project === "iOS Companion App" || IOS_OR_XCODE_RE.test(text)) return "mac";
  if (CLOUD_PROJECTS.has(issue.project)) return "cloud";
  return "mac";
}

/**
 * Validate the materialized route. Missing labels are rejected even when an
 * inference is available: inference is advisory until materialized in Linear.
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
  if (inferred === "mac" && route === "cloud") {
    return { ok: false, route, inferred, materialized: true, reason: "iOS/Xcode/local-secret work cannot use execution:cloud" };
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
