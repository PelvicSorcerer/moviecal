// The project-level planning audit (MOV-514): rules 3 (bucket hygiene) and 4
// (exit stated), as pure functions over fixtures.

import { describe, it, expect } from "vitest";
import {
  auditPlanning,
  exitCondition,
  looksLargerThanOnePr,
  formatPlanningAudit,
  planningAuditSummary,
  OPERATIONS_BACKLOG_PROJECT,
} from "../src/planning-audit.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const project = (overrides = {}) => ({
  name: "Mac CI reliability",
  status: "started",
  description: "Outcome: stop wedging.\nExit: MOV-501 accepted and MOV-499 closed.",
  milestones: [],
  issues: [],
  ...overrides,
});
const opsIssue = (overrides = {}) => ({
  identifier: "MOV-1",
  description: "",
  createdAt: daysAgo(5),
  completedAt: null,
  stateType: "backlog",
  parentId: null,
  linkedPrCount: 0,
  ...overrides,
});
const run = (projects) => auditPlanning(projects, { nowMs: NOW, backlogMaxAgeDays: 60 });
const rules = (findings) => findings.map((f) => f.rule);

describe("exitCondition", () => {
  it("finds Exit: and Done when lines, bulleted or bold", () => {
    expect(exitCondition("Exit: all shipped")).toBe("all shipped");
    expect(exitCondition("intro\n- **Done when:** it works")).toBe("it works");
    expect(exitCondition("## Done when\n\nThe lane is green.")).toBe("The lane is green.");
  });
  it("returns null when absent or empty, and does not match longer words", () => {
    expect(exitCondition("Outcome only")).toBeNull();
    expect(exitCondition("Exit:")).toBeNull();
    expect(exitCondition("Exited the building")).toBeNull();
    expect(exitCondition("")).toBeNull();
  });
});

describe("auditPlanning", () => {
  it("flags a 61-day-old Operations backlog issue but not a 59-day-old one", () => {
    const ops = { name: OPERATIONS_BACKLOG_PROJECT, status: "started", description: "", milestones: [] };
    const findings = run([{ ...ops, issues: [opsIssue({ identifier: "MOV-61", createdAt: daysAgo(61) }), opsIssue({ identifier: "MOV-59", createdAt: daysAgo(59) })] }]);
    expect(findings).toEqual([expect.objectContaining({ rule: "bucket-age", subject: "MOV-61" })]);
  });

  it("ignores finished Operations backlog issues", () => {
    const ops = { name: OPERATIONS_BACKLOG_PROJECT, status: "started", description: "", milestones: [], issues: [opsIssue({ createdAt: daysAgo(200), stateType: "completed" })] };
    expect(run([ops])).toEqual([]);
  });

  it("flags an Operations backlog issue larger than one PR with no parent", () => {
    const ops = { name: OPERATIONS_BACKLOG_PROJECT, status: "started", description: "", milestones: [] };
    const findings = run([
      {
        ...ops,
        issues: [
          opsIssue({ identifier: "MOV-A", linkedPrCount: 2 }),
          opsIssue({ identifier: "MOV-B", description: "Ships in PR #10 and PR #11." }),
          opsIssue({ identifier: "MOV-C", description: "Needs three separate PRs." }),
          opsIssue({ identifier: "MOV-D", linkedPrCount: 2, parentId: "p" }),
          opsIssue({ identifier: "MOV-E", linkedPrCount: 1, description: "One PR #5." }),
        ],
      },
    ]);
    expect(findings.map((f) => f.subject)).toEqual(["MOV-A", "MOV-B", "MOV-C"]);
    expect(rules(findings)).toEqual(["bucket-oversize", "bucket-oversize", "bucket-oversize"]);
  });

  it("never flags Operations backlog for a missing exit or milestones", () => {
    expect(run([{ name: OPERATIONS_BACKLOG_PROJECT, status: "started", description: "", milestones: [], issues: [] }])).toEqual([]);
  });

  it("flags a project with only post-exit issues (bucket drift)", () => {
    const p = project({
      issues: [
        { ...opsIssue({ identifier: "MOV-501", stateType: "completed", createdAt: daysAgo(40), completedAt: daysAgo(10) }) },
        { ...opsIssue({ identifier: "MOV-499", stateType: "completed", createdAt: daysAgo(40), completedAt: daysAgo(8) }) },
        opsIssue({ identifier: "MOV-600", createdAt: daysAgo(3) }),
      ],
    });
    expect(rules(run([p]))).toEqual(["bucket-drift"]);
  });

  it("does not flag drift when an open issue predates the last exit, or an exit is still open", () => {
    const done = (id, completed) => opsIssue({ identifier: id, stateType: "completed", createdAt: daysAgo(40), completedAt: daysAgo(completed) });
    expect(run([project({ issues: [done("MOV-501", 10), done("MOV-499", 8), opsIssue({ identifier: "MOV-9", createdAt: daysAgo(20) })] })])).toEqual([]);
    expect(run([project({ issues: [done("MOV-501", 10), opsIssue({ identifier: "MOV-499", createdAt: daysAgo(40) }), opsIssue({ identifier: "MOV-9", createdAt: daysAgo(1) })] })])).toEqual([]);
    expect(run([project({ issues: [done("MOV-501", 10), done("MOV-499", 8)] })])).toEqual([]);
  });

  it("flags a project and a milestone with no exit line", () => {
    const findings = run([
      project({ name: "No exit", description: "Just an outcome.", milestones: [{ name: "Phase 1", description: "" }, { name: "Phase 2", description: "Exit: shipped" }] }),
    ]);
    expect(findings.map((f) => [f.rule, f.subject])).toEqual([
      ["exit-missing", "No exit"],
      ["exit-missing", "No exit / Phase 1"],
    ]);
  });

  it("flags nothing on a fixture of compliant projects, and skips completed ones", () => {
    const findings = run([
      project(),
      project({ name: "Phased", description: "Done when: both phases ship.", milestones: [{ name: "A", description: "Exit: a" }] }),
      { name: OPERATIONS_BACKLOG_PROJECT, status: "started", description: "", milestones: [], issues: [opsIssue()] },
      project({ name: "Old finished", status: "completed", description: "" }),
    ]);
    expect(findings).toEqual([]);
  });
});

describe("looksLargerThanOnePr", () => {
  it("needs two distinct PR references or two linked PRs", () => {
    expect(looksLargerThanOnePr({ description: "PR #5 and PR #5" })).toBe(false);
    expect(looksLargerThanOnePr({ description: "see /pull/5 and /pull/6" })).toBe(true);
    expect(looksLargerThanOnePr({ linkedPrCount: 2 })).toBe(true);
    expect(looksLargerThanOnePr({})).toBe(false);
  });
});

describe("reporting", () => {
  it("formats findings as log lines and a summary, and an empty run as one line", () => {
    expect(formatPlanningAudit([])).toEqual(["Planning audit: no findings."]);
    const lines = formatPlanningAudit([{ rule: "bucket-age", subject: "MOV-1", message: "old" }]);
    expect(lines[0]).toBe("planning audit [bucket-age] MOV-1: old");
    expect(lines.at(-1)).toMatch(/1 finding\(s\) \(report-only; nothing changed\)/);
  });
  it("summarizes counts by rule", () => {
    expect(planningAuditSummary([{ rule: "a" }, { rule: "a" }, { rule: "b" }], NOW)).toEqual({
      lastRunAt: new Date(NOW).toISOString(),
      findings: 3,
      byRule: { a: 2, b: 1 },
    });
  });
});
