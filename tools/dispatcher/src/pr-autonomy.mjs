// Fail-closed policy and execution adapter for MOV-162's narrowly scoped PR
// readiness and auto-merge rollout. The policy stays independent of GitHub
// transport so its allow/deny matrix is deterministic in tests.

import { JsonStateStore } from "./state-store.mjs";
import { hasDurablePassedVerification } from "./readiness-evidence.mjs";

export const AUTONOMY_DISABLE_LABEL = "autonomy:disabled";
export const AUTONOMY_DISABLE_MARKER = /^\s*Autonomy:\s*disabled\s*$/im;
// This is deliberately an allowlist. New roots or sensitive application
// classes need explicit governance work before they can become eligible.
export const AUTONOMY_SAFE_PATH_PREFIXES = Object.freeze(["docs/", "src/", "test/"]);
export const AUTONOMY_REQUIRED_CHECKS = Object.freeze(["lane-baseline", "lane-unit", "lane-integration", "lane-browser", "lane-review", "lane-ios"]);

const BLOCKING_LABELS = new Set([
  "human-only",
  AUTONOMY_DISABLE_LABEL,
  // Retain the original labels as fail-closed compatibility gates, and match
  // the area labels actually used by the Linear workspace.
  "auth", "calendar", "database", "deployment", "security",
  "area:auth", "area:calendar", "area:database", "area:deployment", "area:security",
  "security-sensitive",
]);
const REQUIRED_LABELS = new Set(["agent-ready", "risk:low", "execution:mac"]);
const REQUIRED_EVIDENCE = [
  /^\s*Autonomy:\s*eligible\s*$/im,
  /^\s*Human testing:\s*not-required\s*$/im,
  /^\s*(?:[-*]\s*)?No-human-testing rationale:\s*\S.+$/im,
];

function labelsOf(issue) {
  return new Set((issue?.labels?.nodes || issue?.labels || []).map((label) => String(label?.name || label).toLowerCase()));
}

function isSensitiveClassification(labels) {
  return [...labels].some((label) => BLOCKING_LABELS.has(label)
    || label.startsWith("security:")
    || label.endsWith(":security")
    || label.includes("security-sensitive"));
}

const SENSITIVE_APPLICATION_PATHS = Object.freeze([
  // API/server entry points and their matching route tests.
  /(?:^|\/)api(?:[/.]|$)/i,
  /(?:^|\/)(?:server|middleware)(?:[._/-]|$)/i,
  /(?:^|\/)[^/]*route(?:[._-]|$)/i,
  // Authentication, private sessions, and calendar-feed/token boundaries.
  /(?:^|\/)(?:auth(?:entication|orization)?|sign-?in|(?:agent-)?session)(?:[._/-]|$)/i,
  /(?:^|\/)(?:calendar|calendar-tokens?|feed|token)(?:[._/-]|$)/i,
  // Data access and real-stack behavior, including private watchlists.
  /(?:^|\/)(?:supabase|database|db|migrations?|real-stack|watchlist|private-watchlists?)(?:[._/-]|$)/i,
  // Operational and security-sensitive application behavior.
  /(?:^|\/)(?:cron|deploy(?:ment)?|security|e2e|browser)(?:[._/-]|$)/i,
]);

/** Return true only for an explicitly approved, non-sensitive changed path. */
export function isAutonomySafePath(file) {
  if (typeof file !== "string" || file.length === 0 || file.startsWith("/") || file.split("/").includes("..")) return false;
  if (file.startsWith("docs/")) return true; // Preserve the shipped docs-only policy unchanged.
  if (!AUTONOMY_SAFE_PATH_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  return !SENSITIVE_APPLICATION_PATHS.some((pattern) => pattern.test(file));
}

function deny(reason) {
  return { eligible: false, action: "none", reason };
}

function hasRequiredEvidence(body) {
  return REQUIRED_EVIDENCE.every((pattern) => pattern.test(String(body || "")))
    && hasDurablePassedVerification(body);
}

function hasPassingAutonomyCheck(name, check, headSha) {
  if (check.sha !== headSha) return false;
  const outcome = String(check.outcome || "").toLowerCase();
  return outcome === "success" || (name === "lane-ios" && outcome === "skipped");
}

/** Decide whether one current PR observation may receive a narrow autonomy action. */
export function evaluatePrAutonomy({ issue, observation, repo, repairAttempts = [], enabled = false } = {}) {
  if (!enabled) return deny("global PR autonomy switch is disabled");
  if (!issue) return deny("Linear issue is unavailable");
  const labels = labelsOf(issue);
  if (isSensitiveClassification(labels)) return deny("issue carries a human or sensitive-work label");
  if (AUTONOMY_DISABLE_MARKER.test(String(issue.description || ""))) return deny("issue's autonomy kill switch is disabled");
  if (![...REQUIRED_LABELS].every((label) => labels.has(label))) return deny("issue is missing the explicit low-risk local allowlist labels");
  if (issue.stateName && issue.stateName !== "In Review") return deny("issue is not in In Review");
  if (!observation || observation.observationError || observation.state !== "OPEN") return deny("PR is not a current open observation");
  if (!observation.headSha) return deny("PR observation has no head SHA");
  if (observation.headRepository && observation.headRepository !== repo) return deny("PR head is not in the trusted repository");
  if (!String(observation.headBranch || "").startsWith(`agent/${issue.identifier}-`)) return deny("PR branch is not owned by the issue");
  if (AUTONOMY_DISABLE_MARKER.test(String(observation.body || ""))) return deny("PR's autonomy kill switch is disabled");
  if (!hasRequiredEvidence(observation.body)) return deny("PR is missing complete explicit autonomy and no-human-testing evidence");
  if (!Array.isArray(observation.changedFiles) || observation.changedFiles.length === 0) return deny("PR has no changed-path evidence");
  if (observation.changedFiles.some((file) => !isAutonomySafePath(file))) return deny("PR changes a sensitive or outside-approved path");
  if (repairAttempts.some((attempt) => ["code-repair", "infrastructure-rerun"].includes(attempt.kind))) return deny("PR has automatic repair activity");
  const checks = observation.checks;
  if (!checks || checks.pending || checks.timedOut || checks.ignoredStale > 0 || checks.missingRequired?.length) return deny("required-check evidence is incomplete, stale, or missing");
  const byName = new Map((checks.checks || checks.required || []).map((check) => [String(check.name).toLowerCase(), check]));
  const required = AUTONOMY_REQUIRED_CHECKS.map((name) => byName.get(name));
  if (required.some((check) => !check)) return deny("a documented required check is missing from the current observation");
  if (required.some((check, index) => !hasPassingAutonomyCheck(AUTONOMY_REQUIRED_CHECKS[index], check, observation.headSha))) return deny("a required check did not pass on the latest SHA");
  if (observation.review?.requestedChanges?.length || observation.review?.blockingRequiredChecks?.length || String(observation.review?.decision || "").toUpperCase() === "CHANGES_REQUESTED") return deny("PR has blocking review feedback");
  if (observation.isDraft) return { eligible: true, action: "ready", reason: "eligible low-risk draft has complete current evidence" };
  return { eligible: true, action: "merge", reason: "eligible ready PR has complete current review-check evidence" };
}

/** Persist action reservations so polling cannot create unbounded retries. */
export class PrAutonomyLedger extends JsonStateStore {
  get label() { return "PR autonomy ledger"; }
  key({ issueIdentifier, prNumber, headSha, action }) { return `${issueIdentifier}:${prNumber}:${headSha}:${action}`; }
  has(input) { return Boolean(this.load()[this.key(input)]); }
  count() { return Object.keys(this.load()).length; }
  reserve(input) {
    const key = this.key(input);
    return this.update((state) => {
      if (state[key]) return state[key];
      const record = { ...input, key, attemptedAt: new Date().toISOString(), outcome: "in-progress", detail: null };
      state[key] = record;
      return record;
    });
  }
  complete(input, { outcome, detail = null } = {}) {
    const key = this.key(input);
    return this.update((state) => {
      if (!state[key]) return null;
      state[key].outcome = outcome;
      state[key].detail = detail;
      state[key].completedAt = new Date().toISOString();
      return state[key];
    });
  }
}

/** The only two GitHub mutations this feature may issue. Neither bypasses rulesets. */
export function applyPrAutonomy({ action, prNumber, repo, runner } = {}) {
  if (!runner) throw new Error("applyPrAutonomy requires a runner");
  if (action === "ready") return runner("gh", ["pr", "ready", String(prNumber), "--repo", repo]);
  if (action === "merge") return runner("gh", ["pr", "merge", String(prNumber), "--auto", "--merge", "--repo", repo]);
  throw new Error(`unsupported PR autonomy action: ${action}`);
}

/** Apply one durable, capped rollout pass and record every actual action in Linear. */
export async function runPrAutonomyPass({ issues = [], worktreeManager, observePrFn, repo, ledger, repairLedger, enabled = false, maxActions = 0, runner, linearClient } = {}) {
  const byIdentifier = new Map(issues.map((issue) => [issue.identifier, issue]));
  const results = [];
  for (const entry of Object.values(worktreeManager.loadState())) {
    if (entry.status !== "review" || !entry.prNumber) continue;
    const issue = byIdentifier.get(entry.id);
    const observation = observePrFn(entry.prNumber, repo);
    const repairAttempts = repairLedger?.attempts ? repairLedger.attempts(entry.id) : [];
    const decision = evaluatePrAutonomy({ issue, observation, repo, repairAttempts, enabled });
    if (decision.action === "none") { results.push({ issue: entry.id, prNumber: entry.prNumber, action: "none", reason: decision.reason }); continue; }
    const input = { issueIdentifier: entry.id, prNumber: entry.prNumber, headSha: observation.headSha, action: decision.action };
    if (ledger.has(input)) { results.push({ issue: entry.id, prNumber: entry.prNumber, action: "none", reason: "this action was already attempted for the current SHA" }); continue; }
    if (!Number.isInteger(maxActions) || maxActions <= ledger.count()) { results.push({ issue: entry.id, prNumber: entry.prNumber, action: "none", reason: "staged rollout action limit is exhausted" }); continue; }
    ledger.reserve(input);
    try {
      // Durably reserve the exact review tuple before the external mutation.
      // If a later local write fails, a non-draft observation of this same
      // tuple still has enough provenance for the bounded state recovery.
      const readyReservation = decision.action === "ready" ? {
        prNumber: entry.prNumber,
        headSha: observation.headSha,
        branch: observation.headBranch,
        repository: observation.headRepository,
        reservedAt: new Date().toISOString(),
      } : null;
      if (readyReservation && typeof worktreeManager.updateEntry === "function") {
        worktreeManager.updateEntry(entry.id, { prAutonomyReady: readyReservation });
      }
      applyPrAutonomy({ action: decision.action, prNumber: entry.prNumber, repo, runner });
      ledger.complete(input, { outcome: "applied" });
      if (readyReservation && typeof worktreeManager.updateEntry === "function") {
        worktreeManager.updateEntry(entry.id, {
          prAutonomyReady: {
            ...readyReservation,
            appliedAt: new Date().toISOString(),
          },
        });
      }
      if (linearClient?.addComment && issue?.id) await linearClient.addComment(issue.id, `**PR autonomy (MOV-162):** ${decision.action} action applied to PR #${entry.prNumber} at SHA \`${observation.headSha}\`. Rollout actions: ${ledger.count()}/${maxActions}. Review this rollout by 2026-10-02.`);
      results.push({ issue: entry.id, prNumber: entry.prNumber, action: decision.action, reason: decision.reason });
    } catch (error) {
      ledger.complete(input, { outcome: "failed", detail: error.message });
      results.push({ issue: entry.id, prNumber: entry.prNumber, action: "failed", reason: error.message });
    }
  }
  return results;
}
