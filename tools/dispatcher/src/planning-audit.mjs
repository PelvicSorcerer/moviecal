// The project-level planning audit (MOV-514).
//
// Report-only, always: even with MOVIECAL_PLANNING_RULES_MODE=enforce nothing
// here moves, fills, or comments on anything. Output is log/health text only.
// The per-issue planning rules live in issue-spec.mjs; these need whole-project
// data, so they are a separate pass over injected, already-fetched snapshots.
//
//   3. Bucket hygiene: Operations backlog issues open longer than a limit;
//      Operations backlog issues larger than one PR with no parent; and bucket
//      drift in an open finite project.
//   4. Exit stated: every non-completed project and milestone, except the
//      standing Operations backlog, states an `Exit:` / `Done when` line.
//
// Bucket drift needs a definition because Linear has no "exit issue" object. An
// *exit issue* is any issue identifier named on the project's `Exit:` /
// `Done when` line. A project has drifted when all its exit issues are
// completed, it still has open issues, and every open issue was created after
// the last exit issue completed. A project that names no exit issues cannot
// drift by this definition and is skipped (rule 4 already flags a missing
// exit line).

import { JsonStateStore } from "./state-store.mjs";

export const OPERATIONS_BACKLOG_PROJECT = "Operations backlog";
const DAY_MS = 24 * 60 * 60 * 1000;

const EXIT_LINE_RE = /^[ \t>]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]*)?\*{0,2}(?:Exit|Done when)\b\*{0,2}[ \t]*:?\*{0,2}[ \t]*(\S[^\n]*)?$/gim;
const ISSUE_ID_RE = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const PR_REF_RE = /(?:\bPR[ \t]*#?|\/pull\/|(?<![\w/])#)(\d+)\b/gi;
const PR_COUNT_WORDS_RE = /\b(?:two|three|four|five|\d+)[ \t]+(?:separate[ \t]+)?(?:PRs|pull requests)\b/i;

/**
 * The text of the first `Exit:` / `Done when` line (or the line after a bare
 * heading/label), or null when the description states none.
 */
export function exitCondition(description) {
  const text = String(description || "");
  EXIT_LINE_RE.lastIndex = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    EXIT_LINE_RE.lastIndex = 0;
    const m = EXIT_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const inline = (m[1] || "").trim();
    if (inline) return inline;
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (next && !/^#{1,6}[ \t]/.test(next)) return next.trim();
  }
  return null;
}

/** True when the issue's description or linked PRs show it is bigger than one PR. */
export function looksLargerThanOnePr(issue) {
  if ((issue.linkedPrCount || 0) >= 2) return true;
  const description = String(issue.description || "");
  const refs = new Set([...description.matchAll(PR_REF_RE)].map((m) => m[1]));
  return refs.size >= 2 || PR_COUNT_WORDS_RE.test(description);
}

const ms = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : null;
};

function backlogFindings(issues, nowMs, maxAgeDays) {
  const findings = [];
  for (const issue of issues) {
    if (issue.stateType === "completed" || issue.stateType === "canceled") continue;
    const created = ms(issue.createdAt);
    if (created !== null && nowMs - created > maxAgeDays * DAY_MS) {
      const days = Math.floor((nowMs - created) / DAY_MS);
      findings.push({
        rule: "bucket-age",
        subject: issue.identifier,
        message: `Operations backlog issue open ${days} days (limit ${maxAgeDays}) — finish it, close it, or give it a parent`,
      });
    }
    if (!issue.parentId && looksLargerThanOnePr(issue)) {
      findings.push({
        rule: "bucket-oversize",
        subject: issue.identifier,
        message: "Operations backlog issue looks larger than one PR but has no parent — add a parent issue or its own project",
      });
    }
  }
  return findings;
}

function driftFinding(project, issues) {
  const exitIds = new Set((exitCondition(project.description) || "").match(ISSUE_ID_RE) || []);
  if (exitIds.size === 0) return null;
  const byId = new Map(issues.map((i) => [i.identifier, i]));
  const exits = [...exitIds].map((id) => byId.get(id)).filter(Boolean);
  if (exits.length !== exitIds.size || !exits.every((i) => i.stateType === "completed" && ms(i.completedAt) !== null)) return null;
  const lastExit = Math.max(...exits.map((i) => ms(i.completedAt)));
  const open = issues.filter((i) => i.stateType !== "completed" && i.stateType !== "canceled" && !exitIds.has(i.identifier));
  if (open.length === 0) return null;
  if (!open.every((i) => ms(i.createdAt) !== null && ms(i.createdAt) > lastExit)) return null;
  return {
    rule: "bucket-drift",
    subject: project.name,
    message: `every open issue (${open.length}) was created after the last exit issue closed — close the project and move this work to a new one`,
  };
}

/**
 * @param {Array<{name: string, status: string, description: string, milestones: Array<{name: string, description: string}>, issues?: object[]}>} projects
 *   non-completed projects; `issues` is required only for the Operations
 *   backlog (rule 3 age/size) and for drift on any project that names exit issues
 * @param {{nowMs?: number, backlogMaxAgeDays?: number}} [options]
 * @returns {Array<{rule: string, subject: string, message: string}>}
 */
export function auditPlanning(projects = [], { nowMs = Date.now(), backlogMaxAgeDays = 60 } = {}) {
  const findings = [];
  for (const project of projects) {
    if (["completed", "canceled", "cancelled"].includes(String(project.status || "").toLowerCase())) continue;
    const issues = project.issues || [];

    if (project.name === OPERATIONS_BACKLOG_PROJECT) {
      for (const f of backlogFindings(issues, nowMs, backlogMaxAgeDays)) findings.push(f);
      continue; // never needs an exit line, no milestones, can never "drift"
    }

    if (!exitCondition(project.description)) {
      findings.push({
        rule: "exit-missing",
        subject: project.name,
        message: "project description states no exit condition (an `Exit:` or `Done when` line)",
      });
    }
    for (const milestone of project.milestones || []) {
      if (!exitCondition(milestone.description)) {
        findings.push({
          rule: "exit-missing",
          subject: `${project.name} / ${milestone.name}`,
          message: "milestone description states no exit condition (an `Exit:` or `Done when` line)",
        });
      }
    }
    const drift = driftFinding(project, issues);
    if (drift) findings.push(drift);
  }
  return findings;
}

/** One log line per finding, then a one-line summary. */
export function formatPlanningAudit(findings = []) {
  if (findings.length === 0) return ["Planning audit: no findings."];
  return [
    ...findings.map((f) => `planning audit [${f.rule}] ${f.subject}: ${f.message}`),
    `Planning audit: ${findings.length} finding(s) (report-only; nothing changed).`,
  ];
}

/** Persisted summary of the last run, read by `dispatcher health`. */
export class PlanningAuditStateStore extends JsonStateStore {
  get label() {
    return "planning audit";
  }
}

export function planningAuditSummary(findings, nowMs = Date.now()) {
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  return { lastRunAt: new Date(nowMs).toISOString(), findings: findings.length, byRule };
}
