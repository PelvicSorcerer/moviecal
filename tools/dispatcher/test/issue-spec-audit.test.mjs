// The issue-completeness audit pass (MOV-303).
//
// Unit coverage of the comment body and marker, then the integration property
// that actually matters and that no single-call assertion can show: run the
// real pass over several *cycles* against a Linear fake that accumulates
// comments the way the real workspace does, and check it comments once, stays
// silent while nothing changes, updates when the missing set changes, goes
// quiet once the issue complies, and never writes anything but a comment.
//
// Same fake-Linear-client shape as run-loop-e2e.test.mjs: a stand-in for the
// real LinearClient's public surface, recording every call so an unexpected
// mutation is an assertion failure rather than something to notice by eye.

import { describe, it, expect } from "vitest";
import {
  auditIssueSpecs,
  auditCommentBody,
  auditCommentMarker,
  lastAuditFingerprint,
  AUDIT_COMMENT_HEADLINE,
} from "../src/issue-spec-audit.mjs";
import { evaluateIssueSpec } from "../src/issue-spec.mjs";

const COMPLETE = {
  labels: ["execution:mac", "type:feat", "risk:low", "worker:any", "model:default", "area:process"],
  project: "Autonomous local-agent delivery",
  projectStatus: "started",
  projectMilestoneCount: 2,
  milestone: "Local acceptance & controlled autonomy",
};

function issue(overrides = {}) {
  return {
    id: "id-1",
    identifier: "MOV-900",
    stateName: "Backlog",
    description: "## Acceptance criteria\n- it works.",
    recentComments: [],
    ...COMPLETE,
    ...overrides,
  };
}

/**
 * A Linear fake that behaves like the workspace across cycles: a posted
 * comment shows up in the issue's `recentComments` on the next pass, which is
 * the only reason the "does not repeat itself" property is testable at all.
 * Every mutating method on the real client's surface is present and records
 * its call, so the audit touching one is a failure, not a silent pass.
 */
function fakeWorkspace(issues) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  return {
    calls: [],
    issues,
    async addComment(issueId, body) {
      this.calls.push({ type: "addComment", issueId, body });
      byId.get(issueId).recentComments.push(body);
      return true;
    },
    async moveToState(issueId, stateId) {
      this.calls.push({ type: "moveToState", issueId, stateId });
    },
    async updateIssuePriority(issueId, priority) {
      this.calls.push({ type: "updateIssuePriority", issueId, priority });
    },
  };
}

const commentsOn = (client, issueId) => client.calls.filter((c) => c.type === "addComment" && c.issueId === issueId);

describe("audit comment marker", () => {
  it("round-trips the missing set through the comment body", () => {
    const evaluation = evaluateIssueSpec(issue({ labels: [], project: null }));
    const body = auditCommentBody(evaluation);
    expect(body).toContain(AUDIT_COMMENT_HEADLINE);
    for (const item of evaluation.missing) expect(body).toContain(item.message);
    expect(lastAuditFingerprint([body])).toBe(auditCommentMarker(evaluation.missing).match(/missing=([^\s]*)/)[1]);
  });

  it("names the kind and says plainly that relations are not checked", () => {
    const body = auditCommentBody(evaluateIssueSpec(issue({ labels: ["human-only"] })));
    expect(body).toMatch(/Kind: `human-only`/);
    expect(body).toMatch(/Relations .* are also required by the contract but are deliberately \*\*not\*\* checked here/);
  });

  it("ignores comments that carry no marker", () => {
    expect(lastAuditFingerprint(["a human wrote this", "**Dispatcher preflight failed:** something"])).toBeNull();
    expect(lastAuditFingerprint([])).toBeNull();
  });

  it("reads the newest marker when an issue has been audited more than once", () => {
    const older = auditCommentMarker([{ code: "risk-missing" }]);
    const newer = auditCommentMarker([{ code: "area-missing" }, { code: "risk-missing" }]);
    expect(lastAuditFingerprint([older, "chatter", newer])).toBe("area-missing,risk-missing");
  });
});

describe("auditIssueSpecs across dispatcher cycles", () => {
  it("comments once, stays silent while nothing changes, updates on a change, then goes quiet when fixed", async () => {
    const target = issue({ id: "id-a", identifier: "MOV-A", labels: [], project: null, milestone: null });
    const client = fakeWorkspace([target]);
    const ctx = { linearClient: client, mode: "report" };

    // Cycle 1: first observation -> exactly one comment naming what's missing.
    const first = await auditIssueSpecs(client.issues, ctx);
    expect(first[0].action).toBe("commented");
    expect(commentsOn(client, "id-a")).toHaveLength(1);
    expect(commentsOn(client, "id-a")[0].body).toContain("no `risk:*` label");
    expect(commentsOn(client, "id-a")[0].body).toContain("no project");

    // Cycle 2: nothing changed -> nothing posted. This is the property that
    // keeps a 30-second poll loop from burying the issue in its own comments.
    const second = await auditIssueSpecs(client.issues, ctx);
    expect(second[0].action).toBe("unchanged");
    expect(commentsOn(client, "id-a")).toHaveLength(1);

    // Cycle 3: a human fills in some of it -> the missing set changed, so one
    // updated comment is posted, naming only what is still missing.
    target.labels = ["execution:mac", "type:feat", "risk:low", "worker:any", "model:default", "area:process"];
    const third = await auditIssueSpecs(client.issues, ctx);
    expect(third[0].action).toBe("updated");
    expect(commentsOn(client, "id-a")).toHaveLength(2);
    expect(commentsOn(client, "id-a")[1].body).not.toContain("no `risk:*` label");
    expect(commentsOn(client, "id-a")[1].body).toContain("no project");

    // Cycle 4: unchanged again -> silent again.
    await auditIssueSpecs(client.issues, ctx);
    expect(commentsOn(client, "id-a")).toHaveLength(2);

    // Cycle 5: fully fixed -> no new comment, and no "resolved" comment either.
    target.project = "Autonomous local-agent delivery";
    target.projectStatus = "started";
    target.milestone = "Local acceptance & controlled autonomy";
    const fifth = await auditIssueSpecs(client.issues, ctx);
    expect(fifth[0]).toMatchObject({ action: "compliant", missing: [] });
    expect(commentsOn(client, "id-a")).toHaveLength(2);

    // Nothing but comments, ever.
    expect(client.calls.every((c) => c.type === "addComment")).toBe(true);
  });

  it("stays silent when an issue regresses to a missing set it has already been told about", async () => {
    const target = issue({ id: "id-b", identifier: "MOV-B", project: null });
    const client = fakeWorkspace([target]);
    const ctx = { linearClient: client, mode: "report" };

    await auditIssueSpecs(client.issues, ctx);
    target.project = "Autonomous local-agent delivery";
    expect((await auditIssueSpecs(client.issues, ctx))[0].action).toBe("compliant");
    target.project = null;
    // The last marker still records `project-missing`, so this is "unchanged"
    // against the last *audit*, not against the last compliant state -- and
    // re-posting would be the nag this pass exists to avoid.
    expect((await auditIssueSpecs(client.issues, ctx))[0].action).toBe("unchanged");
    expect(commentsOn(client, "id-b")).toHaveLength(1);
  });

  it("covers the issues the promoter never looks at", async () => {
    const issues = [
      issue({ id: "id-human", identifier: "MOV-H", stateName: "Spec Ready", labels: ["human-only", "execution:none", "type:chore"] }),
      issue({ id: "id-coord", identifier: "MOV-C", stateName: "Icebox", labels: ["type:coordination", "execution:none"] }),
      issue({ id: "id-started", identifier: "MOV-S", stateName: "In Review", labels: [] }),
      issue({ id: "id-ok", identifier: "MOV-OK", stateName: "Agent Working" }),
      issue({ id: "id-triage", identifier: "MOV-T", stateName: "Triage", labels: [], project: null }),
      issue({ id: "id-done", identifier: "MOV-D", stateName: "Done", labels: [], project: null }),
    ];
    const client = fakeWorkspace(issues);
    const results = await auditIssueSpecs(issues, { linearClient: client, mode: "report" });

    expect(results.map((r) => [r.issue, r.action])).toEqual([
      ["MOV-H", "commented"],
      ["MOV-C", "commented"],
      ["MOV-S", "commented"],
      ["MOV-OK", "compliant"],
      ["MOV-T", "exempt"],
      ["MOV-D", "exempt"],
    ]);
    // human-only and coordination issues are judged by their own rules: no
    // worker:*/model:* demand on either.
    const humanOnly = commentsOn(client, "id-human")[0].body;
    expect(humanOnly).toContain("no `risk:*` label");
    expect(humanOnly).not.toContain("`worker:*`");
    expect(humanOnly).not.toContain("`model:*`");
  });

  it("--dry-run and mode off report every violation and write nothing", async () => {
    for (const ctx of [{ dryRun: true, mode: "report" }, { dryRun: false, mode: "off" }]) {
      const target = issue({ id: "id-c", identifier: "MOV-C2", labels: [], project: null });
      const client = fakeWorkspace([target]);
      const results = await auditIssueSpecs(client.issues, { linearClient: client, ...ctx });
      expect(results[0].action, JSON.stringify(ctx)).toBe("would-comment");
      expect(results[0].missing.length).toBeGreaterThan(0);
      expect(client.calls, JSON.stringify(ctx)).toHaveLength(0);
    }
  });

  it("behaves identically in report and enforce mode — the audit tells, the promoter gates", async () => {
    const forMode = async (mode) => {
      const target = issue({ id: "id-d", identifier: "MOV-D2", labels: [], project: null });
      const client = fakeWorkspace([target]);
      const results = await auditIssueSpecs(client.issues, { linearClient: client, mode });
      return { action: results[0].action, comments: commentsOn(client, "id-d").length };
    };
    expect(await forMode("report")).toEqual(await forMode("enforce"));
    expect(await forMode("enforce")).toEqual({ action: "commented", comments: 1 });
  });
});
