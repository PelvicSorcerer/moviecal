// The issue completeness contract (MOV-303).
//
// Every rule in docs/governance/linear-information-architecture.md §Issue
// completeness contract, per kind, plus the two exemptions and the milestone
// opt-out marker.

import { describe, it, expect } from "vitest";
import {
  evaluateIssueSpec,
  issueSpecKind,
  issueSpecFingerprint,
  formatIssueSpecMissing,
  milestoneOptOutReason,
  ISSUE_SPEC_MODES,
  DEFAULT_ISSUE_SPEC_MODE,
  EXEMPT_SPEC_STATE_NAMES,
  AUDITED_SPEC_STATE_TYPES,
} from "../src/issue-spec.mjs";

const COMPLETE_DISPATCHABLE_LABELS = [
  "execution:mac",
  "type:feat",
  "risk:medium",
  "worker:any",
  "model:default",
  "area:process",
];

function issue(overrides = {}) {
  return {
    id: "id-1",
    identifier: "MOV-900",
    title: "A fully specced issue",
    stateName: "Backlog",
    description: "## Acceptance criteria\n- it works.",
    labels: [...COMPLETE_DISPATCHABLE_LABELS],
    project: "Autonomous local-agent delivery",
    projectStatus: "started",
    projectMilestoneCount: 2,
    milestone: "Local acceptance & controlled autonomy",
    ...overrides,
  };
}

/** The codes of what's missing — stable identity, independent of wording. */
function codes(evaluation) {
  return evaluation.missing.map((item) => item.code);
}

describe("evaluateIssueSpec — exemptions", () => {
  it("never flags a Triage issue, however empty", () => {
    const v = evaluateIssueSpec({ stateName: "Triage", labels: [], project: null, description: "" });
    expect(v).toMatchObject({ exempt: true, ok: true, missing: [], kind: null });
  });

  it("never flags a terminal-state issue", () => {
    for (const stateName of ["Done", "Released", "Canceled", "Duplicate"]) {
      const v = evaluateIssueSpec({ stateName, labels: [], project: null, description: "" });
      expect(v.exempt, stateName).toBe(true);
      expect(v.ok, stateName).toBe(true);
    }
  });

  it("exempts exactly Triage plus the four terminal states, and audits the open state types", () => {
    expect(EXEMPT_SPEC_STATE_NAMES).toEqual(["Triage", "Done", "Released", "Canceled", "Duplicate"]);
    expect([...AUDITED_SPEC_STATE_TYPES].sort()).toEqual(["backlog", "started", "unstarted"]);
  });

  it("checks every other open state, including the ones the promoter never sees", () => {
    for (const stateName of ["Backlog", "Icebox", "Spec Ready", "Ready for Agent", "Agent Working", "In Review", "Blocked", "Needs Input", "Needs Human Decision"]) {
      const v = evaluateIssueSpec(issue({ stateName, labels: [] }));
      expect(v.exempt, stateName).toBe(false);
      expect(v.ok, stateName).toBe(false);
    }
  });
});

describe("evaluateIssueSpec — dispatchable issues", () => {
  it("accepts a fully specced issue", () => {
    const v = evaluateIssueSpec(issue());
    expect(v).toMatchObject({ exempt: false, kind: "dispatchable", ok: true, missing: [], reason: null });
  });

  it.each([
    ["execution", "execution:mac", "execution-missing"],
    ["type", "type:feat", "type-missing"],
    ["risk", "risk:medium", "risk-missing"],
    ["worker", "worker:any", "worker-missing"],
    ["model", "model:default", "model-missing"],
  ])("reports a missing %s:* single-select group", (group, label, code) => {
    const labels = COMPLETE_DISPATCHABLE_LABELS.filter((l) => l !== label);
    const v = evaluateIssueSpec(issue({ labels }));
    expect(codes(v)).toEqual([code]);
    expect(v.reason).toContain(`\`${group}:*\``);
  });

  it("reports more than one label from a single-select group", () => {
    const v = evaluateIssueSpec(issue({ labels: [...COMPLETE_DISPATCHABLE_LABELS, "risk:high"] }));
    expect(codes(v)).toEqual(["risk-multiple"]);
    expect(v.reason).toMatch(/risk:medium, risk:high/);
    expect(v.reason).toMatch(/exactly one/);
  });

  it("reports no area:* label", () => {
    const v = evaluateIssueSpec(issue({ labels: COMPLETE_DISPATCHABLE_LABELS.filter((l) => l !== "area:process") }));
    expect(codes(v)).toEqual(["area-missing"]);
  });

  it("accepts more than one area:* label", () => {
    const v = evaluateIssueSpec(issue({ labels: [...COMPLETE_DISPATCHABLE_LABELS, "area:tests"] }));
    expect(v.ok).toBe(true);
  });

  it("reports model:strong without an upgrade:* label, reusing worker-routing's own rule", () => {
    const labels = COMPLETE_DISPATCHABLE_LABELS.map((l) => (l === "model:default" ? "model:strong" : l));
    const v = evaluateIssueSpec(issue({ labels }));
    expect(codes(v)).toEqual(["upgrade-missing"]);
    // The message is resolveRouting()'s verbatim, not a paraphrase of it --
    // that is what stops this rule and the dispatch-time one from drifting.
    expect(v.reason).toBe(
      "model:strong requires an upgrade-condition label (upgrade:multi-system | upgrade:ambiguous-spec | upgrade:security-critical | upgrade:prior-failure | upgrade:architecture)",
    );
  });

  it("accepts model:strong once an upgrade condition is cited", () => {
    const labels = [
      ...COMPLETE_DISPATCHABLE_LABELS.filter((l) => l !== "model:default"),
      "model:strong",
      "upgrade:multi-system",
    ];
    expect(evaluateIssueSpec(issue({ labels })).ok).toBe(true);
  });

  it("does not require upgrade:* for the default or cheap tiers", () => {
    for (const tier of ["model:default", "model:cheap"]) {
      const labels = COMPLETE_DISPATCHABLE_LABELS.map((l) => (l === "model:default" ? tier : l));
      expect(evaluateIssueSpec(issue({ labels })).ok, tier).toBe(true);
    }
  });

  it("reports every missing item at once, not just the first", () => {
    const v = evaluateIssueSpec(issue({ labels: ["execution:mac", "model:strong"], project: null }));
    expect(codes(v)).toEqual([
      "type-missing",
      "risk-missing",
      "worker-missing",
      "upgrade-missing",
      "area-missing",
      "project-missing",
    ]);
    expect(formatIssueSpecMissing(v.missing).split("; ")).toHaveLength(6);
  });
});

describe("evaluateIssueSpec — human-only issues", () => {
  const humanOnly = (overrides = {}) =>
    issue({
      labels: ["human-only", "execution:none", "type:chore", "risk:low", "area:process"],
      ...overrides,
    });

  it("accepts execution:none + type + risk + area, with no worker:* or model:*", () => {
    const v = evaluateIssueSpec(humanOnly());
    expect(v).toMatchObject({ kind: "human-only", ok: true });
  });

  it("requires execution:none specifically, not just any execution label", () => {
    const v = evaluateIssueSpec(humanOnly({ labels: ["human-only", "execution:mac", "type:chore", "risk:low", "area:process"] }));
    expect(codes(v)).toEqual(["execution-wrong"]);
    expect(v.reason).toMatch(/`execution:none` is required on `human-only` issues \(found execution:mac\)/);
  });

  it("reports a missing execution label", () => {
    const v = evaluateIssueSpec(humanOnly({ labels: ["human-only", "type:chore", "risk:low", "area:process"] }));
    expect(codes(v)).toEqual(["execution-missing"]);
  });

  it("still requires type:*, risk:* and area:*", () => {
    const v = evaluateIssueSpec(humanOnly({ labels: ["human-only", "execution:none"] }));
    expect(codes(v)).toEqual(["type-missing", "risk-missing", "area-missing"]);
  });

  it("never asks a human-only issue for worker:*, model:* or upgrade:*", () => {
    const v = evaluateIssueSpec(humanOnly({ labels: ["human-only", "execution:none", "type:chore", "risk:low", "area:process", "model:strong"] }));
    expect(v.ok).toBe(true);
  });
});

describe("evaluateIssueSpec — coordination issues", () => {
  const coordination = (overrides = {}) =>
    issue({ labels: ["type:coordination", "execution:none", "risk:low", "area:process"], ...overrides });

  it("accepts execution:none + risk + area", () => {
    const v = evaluateIssueSpec(coordination());
    expect(v).toMatchObject({ kind: "coordination", ok: true });
  });

  it("requires execution:none", () => {
    const v = evaluateIssueSpec(coordination({ labels: ["type:coordination", "risk:low", "area:process"] }));
    expect(codes(v)).toEqual(["execution-missing"]);
    expect(v.reason).toMatch(/required on coordination issues/);
  });

  it("requires risk:* and area:*", () => {
    const v = evaluateIssueSpec(coordination({ labels: ["type:coordination", "execution:none"] }));
    expect(codes(v)).toEqual(["risk-missing", "area-missing"]);
  });

  it("never asks a coordination issue for worker:* or model:*", () => {
    expect(evaluateIssueSpec(coordination()).ok).toBe(true);
  });
});

describe("issueSpecKind", () => {
  it("classifies by label, with human-only winning over coordination", () => {
    expect(issueSpecKind({ labels: ["execution:mac"] })).toBe("dispatchable");
    expect(issueSpecKind({ labels: ["type:coordination"] })).toBe("coordination");
    expect(issueSpecKind({ labels: ["human-only"] })).toBe("human-only");
    expect(issueSpecKind({ labels: ["human-only", "type:coordination"] })).toBe("human-only");
  });
});

describe("evaluateIssueSpec — project", () => {
  it("reports a missing project", () => {
    const v = evaluateIssueSpec(issue({ project: null, projectMilestoneCount: 0, milestone: null }));
    expect(codes(v)).toEqual(["project-missing"]);
  });

  it("reports a completed or canceled project", () => {
    for (const status of ["completed", "canceled"]) {
      const v = evaluateIssueSpec(issue({ projectStatus: status }));
      expect(codes(v), status).toEqual(["project-terminal"]);
      expect(v.reason).toContain(status);
    }
  });

  it("accepts every non-terminal project status, including an unreadable one", () => {
    for (const status of ["planned", "started", "paused", "backlog", null, undefined, ""]) {
      expect(evaluateIssueSpec(issue({ projectStatus: status })).ok, String(status)).toBe(true);
    }
  });
});

describe("evaluateIssueSpec — milestone", () => {
  it("reports a missing milestone when the project has milestones", () => {
    const v = evaluateIssueSpec(issue({ milestone: null }));
    expect(codes(v)).toEqual(["milestone-missing"]);
    expect(v.reason).toMatch(/defines 2 milestone\(s\)/);
  });

  it("does not require a milestone when the project defines none", () => {
    expect(evaluateIssueSpec(issue({ milestone: null, projectMilestoneCount: 0 })).ok).toBe(true);
  });

  it("accepts an explicit, reasoned opt-out line", () => {
    const v = evaluateIssueSpec(
      issue({
        milestone: null,
        description: "## Acceptance criteria\n- it works.\n\nMilestone: N/A — cross-cutting hotfix, outside every phase.",
      }),
    );
    expect(v.ok).toBe(true);
  });

  it("rejects the opt-out marker with an empty reason", () => {
    for (const line of ["Milestone: N/A —", "Milestone: N/A — ", "Milestone: N/A -", "Milestone: N/A"]) {
      const v = evaluateIssueSpec(issue({ milestone: null, description: `## Acceptance criteria\n- x\n\n${line}\n` }));
      expect(codes(v), line).toEqual(["milestone-missing"]);
    }
  });

  it("accepts the marker bulleted, bolded, or written with a plain hyphen", () => {
    for (const line of [
      "- Milestone: N/A — no phase applies",
      "**Milestone:** N/A — no phase applies",
      "Milestone: N/A - no phase applies",
      "Milestone: N/A – no phase applies",
    ]) {
      const v = evaluateIssueSpec(issue({ milestone: null, description: `## Acceptance criteria\n- x\n\n${line}\n` }));
      expect(v.ok, line).toBe(true);
    }
  });

  it("does not accept the marker mentioned mid-sentence", () => {
    const v = evaluateIssueSpec(
      issue({ milestone: null, description: "We considered writing Milestone: N/A — but decided against it." }),
    );
    // The line must start with the marker; a sentence that merely contains it
    // (and here, in prose, explicitly declines it) is not an opt-out.
    expect(codes(v)).toEqual(["milestone-missing"]);
  });

  it("milestoneOptOutReason returns the reason text, or null", () => {
    expect(milestoneOptOutReason("Milestone: N/A — process work, no phase")).toBe("process work, no phase");
    expect(milestoneOptOutReason("Milestone: N/A —")).toBeNull();
    expect(milestoneOptOutReason("")).toBeNull();
    expect(milestoneOptOutReason(undefined)).toBeNull();
  });
});

describe("issueSpecFingerprint", () => {
  it("is order-independent and identifies the set, not the wording", () => {
    const a = [{ code: "risk-missing", message: "x" }, { code: "project-missing", message: "y" }];
    const b = [{ code: "project-missing", message: "totally different wording" }, { code: "risk-missing", message: "z" }];
    expect(issueSpecFingerprint(a)).toBe(issueSpecFingerprint(b));
    expect(issueSpecFingerprint(a)).toBe("project-missing,risk-missing");
  });

  it("changes when an item is added or removed", () => {
    const one = [{ code: "risk-missing", message: "x" }];
    const two = [...one, { code: "area-missing", message: "y" }];
    expect(issueSpecFingerprint(one)).not.toBe(issueSpecFingerprint(two));
    expect(issueSpecFingerprint([])).toBe("");
  });
});

describe("modes", () => {
  it("offers exactly off/report/enforce and defaults to report", () => {
    expect(ISSUE_SPEC_MODES).toEqual(["off", "report", "enforce"]);
    expect(DEFAULT_ISSUE_SPEC_MODE).toBe("report");
  });
});
