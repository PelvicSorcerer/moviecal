import { describe, expect, it } from "vitest";
import { evaluateIssueSpec } from "../src/issue-spec.mjs";
import { evaluatePromotion } from "../src/promoter.mjs";
import { resolveRouting } from "../src/worker-routing.mjs";
import {
  MASTER_INCIDENT_COMMENT_MARKER,
  masterIncidentEvidenceBlock,
  masterIncidentHumanDecisionComment,
  masterIncidentIssueBody,
  masterIncidentLabels,
  masterIncidentReconciledComment,
  masterIncidentRoutedComment,
  masterIncidentSourceComment,
  masterIncidentTitle,
} from "../src/master-incident-issue.mjs";

const evidence = {
  key: "master-ci:4242:1:aaaaaaaaaaaabbbb",
  runId: 4242,
  runAttempt: 1,
  runUrl: "https://github.com/PelvicSorcerer/moviecal/actions/runs/4242",
  workflowName: "ios-verify",
  lanes: ["lane-ios"],
  conclusion: "failure",
  headSha: "aaaaaaaaaaaabbbb",
  runCreatedAt: "2026-09-23T10:00:00Z",
  observedAt: "2026-09-23T10:05:00Z",
  prNumber: 602,
  prUrl: "https://github.com/PelvicSorcerer/moviecal/pull/602",
  sourceIssue: "MOV-293",
  classification: "code-test",
  classificationReason: "lane-ios: failure points to repository code or test behavior",
};

const decision = { action: "route-fix-pr", reason: "deterministic code-test failure", humanDecision: null };

/** The shape `evaluateIssueSpec`/`evaluatePromotion` read, as the observer files it. */
function filedIssue({ milestoneAssigned = true } = {}) {
  return {
    stateName: "Backlog",
    labels: masterIncidentLabels(),
    project: "Autonomous local-agent delivery",
    projectStatus: "started",
    projectMilestoneCount: 2,
    milestone: milestoneAssigned ? "Local acceptance & controlled autonomy" : null,
    description: masterIncidentIssueBody({ evidence, decision, milestoneAssigned }),
    blockedByIds: [],
  };
}

describe("the master remediation issue (MOV-305)", () => {
  it("satisfies the real issue-completeness contract, not a copy of its rules", () => {
    const result = evaluateIssueSpec(filedIssue());
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("satisfies the contract via the explicit opt-out when no milestone resolved", () => {
    const result = evaluateIssueSpec(filedIssue({ milestoneAssigned: false }));
    expect(result.missing).toEqual([]);
  });

  it("is promotable by the real promoter in enforce mode, with no hand-written intake pass", () => {
    const result = evaluatePromotion(filedIssue(), { isBlockerSatisfied: () => true, issueSpecMode: "enforce" });
    expect(result.promote).toBe(true);
  });

  it("routes to a worker without needing an upgrade-condition label", () => {
    expect(resolveRouting({ labels: masterIncidentLabels() })).toMatchObject({ ok: true, worker: "claude", model: "default" });
  });

  it("carries risk:high, so MOV-162 PR autonomy can never make its fix PR ready or merge it", () => {
    expect(masterIncidentLabels()).toContain("risk:high");
    expect(masterIncidentLabels()).not.toContain("risk:low");
  });

  it("carries execution:mac so the local dispatcher is allowed to claim it at all", () => {
    expect(masterIncidentLabels()).toContain("execution:mac");
  });

  it("records every required piece of evidence in the body", () => {
    const body = masterIncidentIssueBody({ evidence, decision });
    for (const fragment of [
      evidence.runUrl,
      "ios-verify",
      "lane-ios",
      "failure",
      evidence.headSha,
      "#602",
      "MOV-293",
      evidence.observedAt,
      evidence.key,
    ]) {
      expect(body).toContain(fragment);
    }
  });

  it("states in the issue itself that master is never written to directly", () => {
    const body = masterIncidentIssueBody({ evidence, decision });
    expect(body).toMatch(/No commit, merge, revert, force-push, or blind re-run is performed against `master` directly/);
    expect(body).toMatch(/based on current `master`/);
  });

  it("titles the incident by lane, run, and commit so duplicates are recognizable", () => {
    expect(masterIncidentTitle(evidence)).toBe("Fix failed lane-ios on master (run 4242, aaaaaaaaaaaa)");
  });

  it("renders the evidence block identically wherever it appears", () => {
    const block = masterIncidentEvidenceBlock(evidence);
    expect(masterIncidentIssueBody({ evidence, decision })).toContain(block);
    expect(masterIncidentHumanDecisionComment({ evidence, decision })).toContain(block);
  });

  it("gives a human-decision comment the four things acceptance criterion 5 names", () => {
    const comment = masterIncidentHumanDecisionComment({
      evidence: { ...evidence, classification: "infrastructure-transient" },
      decision: { reason: "runner died", humanDecision: "confirm the runner is healthy" },
    });
    expect(comment).toContain(evidence.runUrl);
    expect(comment).toContain(evidence.headSha);
    expect(comment).toContain("infrastructure-transient");
    expect(comment).toContain("confirm the runner is healthy");
  });

  it("marks every comment surface with the incident key so replays are recognizable", () => {
    for (const comment of [
      masterIncidentRoutedComment({ evidence, decision }),
      masterIncidentHumanDecisionComment({ evidence, decision }),
      masterIncidentReconciledComment({ evidence, reconciliation: { prNumber: 700, verifiedSha: "cccc" } }),
      masterIncidentSourceComment({ evidence, remediation: { identifier: "MOV-999" } }),
    ]) {
      expect(comment).toContain(`${MASTER_INCIDENT_COMMENT_MARKER}:${evidence.key}`);
    }
  });

  it("tells the source issue it is a notice rather than a state change", () => {
    const comment = masterIncidentSourceComment({ evidence, remediation: { identifier: "MOV-999", url: "https://example.test/MOV-999" } });
    expect(comment).toMatch(/notice, not a state change/);
    expect(comment).toContain("MOV-999");
  });

  it("keeps the original failure evidence in the reconciliation comment", () => {
    const comment = masterIncidentReconciledComment({
      evidence,
      reconciliation: { prNumber: 700, verifiedSha: "cccc", reason: "green on cccc" },
    });
    expect(comment).toContain(evidence.headSha);
    expect(comment).toContain("#700");
    expect(comment).toContain("cccc");
  });
});
