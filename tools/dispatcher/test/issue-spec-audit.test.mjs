// The issue-completeness audit pass (MOV-308).
//
// Two things need proving here, and only one of them is about a single call.
//
// The first is the comment itself: its headline, the missing items it names,
// and the hidden fingerprint marker round-tripping back out of the body it was
// written into.
//
// The second is the property that only shows up *across cycles*, which is
// where a pass that runs every 30 seconds either behaves or buries an issue
// under identical comments: it comments once, then stays silent on an
// unchanged missing set, posts exactly one updated comment when the set
// changes,
// goes quiet when the issue is fixed, and never writes anything but a comment
// at any point in that sequence. Each of those is a separate assertion below,
// but they run against one fake Linear client whose comment log feeds the next
// pass — the same way the real `issuesForSpecAudit` query feeds it.

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditIssueSpecs,
  auditCommentBody,
  auditCommentMarker,
  auditFingerprintToken,
  parseAuditCommentMarker,
  lastAuditFingerprint,
  AUDIT_COMMENT_HEADLINE,
  IssueSpecAuditScheduleStore,
  isAuditDue,
} from "../src/issue-spec-audit.mjs";
import { evaluateIssueSpec, issueSpecFingerprint } from "../src/issue-spec.mjs";
import { PROMOTION_COMMENT } from "../src/promoter.mjs";

const COMPLETE_DISPATCHABLE_LABELS = [
  "execution:mac",
  "type:fix",
  "risk:low",
  "worker:any",
  "model:default",
  "area:process",
];

function issue(overrides = {}) {
  return {
    id: "id-audit",
    identifier: "MOV-900",
    title: "An issue the promoter never looks at",
    stateName: "Spec Ready",
    description: "## Acceptance criteria\n- it works.",
    labels: [...COMPLETE_DISPATCHABLE_LABELS],
    project: "Autonomous local-agent delivery",
    projectStatus: "started",
    projectMilestoneCount: 0,
    milestone: null,
    recentComments: [],
    ...overrides,
  };
}

/**
 * A fake Linear client that fails loudly on any mutation other than
 * `addComment`, and accumulates comment bodies so a later pass reads back what
 * an earlier one wrote — exactly what `issuesForSpecAudit`'s `recentComments`
 * does against the real API.
 */
function fakeLinearClient() {
  const forbidden = [
    "moveToState",
    "updateIssuePriority",
    "addBlocksRelation",
    "linkBlockingChain",
    "createAgentActivity",
    "createAgentSessionOnIssue",
    "updateAgentSessionExternalLink",
  ];
  const client = {
    comments: [],
    async addComment(issueId, body) {
      this.comments.push({ issueId, body });
      return true;
    },
    bodiesFor(issueId) {
      return this.comments.filter((c) => c.issueId === issueId).map((c) => c.body);
    },
  };
  for (const name of forbidden) {
    client[name] = vi.fn(() => {
      throw new Error(`the audit pass must never call ${name}`);
    });
  }
  return client;
}

describe("the audit comment and its fingerprint marker", () => {
  it("heads every comment with the exact contract headline and names each missing item", () => {
    const evaluation = evaluateIssueSpec(issue({ labels: ["execution:mac"], project: null }));
    const body = auditCommentBody(evaluation);

    expect(body.startsWith(AUDIT_COMMENT_HEADLINE)).toBe(true);
    expect(AUDIT_COMMENT_HEADLINE).toBe(
      "**Issue completeness contract — this issue is missing required fields (MOV-303).**",
    );
    for (const item of evaluation.missing) expect(body).toContain(`- ${item.message}`);
    // Which rules were applied, so a reader does not have to guess why a
    // `human-only` issue is not being asked for a `worker:*` label.
    expect(body).toContain("dispatchable");
    expect(body).toContain("§Issue completeness contract");
  });

  it("round-trips the fingerprint through the hidden marker in the body it wrote", () => {
    const evaluation = evaluateIssueSpec(issue({ labels: [], project: null }));
    const body = auditCommentBody(evaluation);
    const expected = auditFingerprintToken(issueSpecFingerprint(evaluation.missing));

    expect(parseAuditCommentMarker(body)).toBe(expected);
    expect(body).toContain(auditCommentMarker(issueSpecFingerprint(evaluation.missing)));
    // Hidden: an HTML comment, and never `--` or `>` inside one.
    expect(body).toMatch(/<!--\s*moviecal-issue-spec-audit:[^\s>]*\s*-->/);
    expect(expected).not.toContain("--");
  });

  it("identifies a missing *set*, not the wording of its messages", () => {
    const noRisk = evaluateIssueSpec(issue({ labels: COMPLETE_DISPATCHABLE_LABELS.filter((l) => l !== "risk:low") }));
    const alsoNoRisk = evaluateIssueSpec(
      issue({ labels: COMPLETE_DISPATCHABLE_LABELS.filter((l) => l !== "risk:low"), title: "different title" }),
    );
    const noProject = evaluateIssueSpec(issue({ project: null }));

    expect(parseAuditCommentMarker(auditCommentBody(noRisk))).toBe(
      parseAuditCommentMarker(auditCommentBody(alsoNoRisk)),
    );
    expect(parseAuditCommentMarker(auditCommentBody(noRisk))).not.toBe(
      parseAuditCommentMarker(auditCommentBody(noProject)),
    );
  });

  it("reads the most recent audit marker and ignores every other comment", () => {
    const older = auditCommentBody(evaluateIssueSpec(issue({ project: null })));
    const newer = auditCommentBody(evaluateIssueSpec(issue({ labels: [] })));

    expect(lastAuditFingerprint([])).toBeNull();
    expect(lastAuditFingerprint([PROMOTION_COMMENT, "a human comment"])).toBeNull();
    expect(lastAuditFingerprint([older, PROMOTION_COMMENT, newer, "a human reply"])).toBe(
      parseAuditCommentMarker(newer),
    );
  });
});

describe("auditIssueSpecs across cycles", () => {
  it("comments once on a non-compliant issue, then stays silent while nothing changes", async () => {
    const linearClient = fakeLinearClient();
    const subject = issue({ project: null });

    const first = await auditIssueSpecs([subject], { linearClient });
    expect(first).toEqual([
      expect.objectContaining({ issue: "MOV-900", action: "commented", missing: [expect.stringContaining("no project")] }),
    ]);
    expect(linearClient.comments).toHaveLength(1);
    expect(linearClient.comments[0].issueId).toBe("id-audit");
    expect(linearClient.comments[0].body).toContain(AUDIT_COMMENT_HEADLINE);

    // Cycle two reads back what cycle one wrote, exactly as the real query does.
    const second = await auditIssueSpecs(
      [{ ...subject, recentComments: linearClient.bodiesFor("id-audit") }],
      { linearClient },
    );
    expect(second[0].action).toBe("unchanged");
    expect(linearClient.comments).toHaveLength(1);
  });

  it("posts exactly one updated comment when the missing set changes, and only then", async () => {
    const linearClient = fakeLinearClient();
    const subject = issue({ project: null, labels: COMPLETE_DISPATCHABLE_LABELS.filter((l) => l !== "risk:low") });

    await auditIssueSpecs([subject], { linearClient });
    expect(linearClient.comments).toHaveLength(1);

    // The project is assigned; the missing risk label is not.
    const partlyFixed = {
      ...subject,
      project: "Autonomous local-agent delivery",
      recentComments: linearClient.bodiesFor("id-audit"),
    };
    const updated = await auditIssueSpecs([partlyFixed], { linearClient });

    expect(updated[0]).toMatchObject({ action: "updated" });
    expect(linearClient.comments).toHaveLength(2);
    expect(linearClient.comments[1].body).toContain("no `risk:*` label");
    expect(linearClient.comments[1].body).not.toContain("no project");

    // And the new set is now the silent one.
    const quiet = await auditIssueSpecs(
      [{ ...partlyFixed, recentComments: linearClient.bodiesFor("id-audit") }],
      { linearClient },
    );
    expect(quiet[0].action).toBe("unchanged");
    expect(linearClient.comments).toHaveLength(2);
  });

  it("goes quiet when the issue is fixed — no comment, and no 'resolved' comment either", async () => {
    const linearClient = fakeLinearClient();
    const subject = issue({ project: null });
    await auditIssueSpecs([subject], { linearClient });

    const fixed = { ...subject, project: "Autonomous local-agent delivery", recentComments: linearClient.bodiesFor("id-audit") };
    const results = await auditIssueSpecs([fixed], { linearClient });

    expect(results[0]).toMatchObject({ action: "compliant", missing: [], fingerprint: null });
    expect(linearClient.comments).toHaveLength(1);
  });

  it("stays silent on a Triage or terminal issue however incomplete it is", async () => {
    const linearClient = fakeLinearClient();
    const issues = ["Triage", "Done", "Released", "Canceled", "Duplicate"].map((stateName, i) =>
      issue({ id: `id-${i}`, identifier: `MOV-${i}`, stateName, labels: [], project: null }),
    );

    const results = await auditIssueSpecs(issues, { linearClient });

    expect(results.map((r) => r.action)).toEqual(Array(5).fill("exempt"));
    expect(linearClient.comments).toEqual([]);
  });

  it("is not confused by the promoter's own comments landing on the same issue in between", async () => {
    const linearClient = fakeLinearClient();
    const subject = issue({ project: null });
    await auditIssueSpecs([subject], { linearClient });

    const withPromoterNoise = {
      ...subject,
      recentComments: [...linearClient.bodiesFor("id-audit"), PROMOTION_COMMENT, "Auto-promoted, looks good"],
    };
    const results = await auditIssueSpecs([withPromoterNoise], { linearClient });

    expect(results[0].action).toBe("unchanged");
    expect(linearClient.comments).toHaveLength(1);
  });

  it("evaluates and reports under --dry-run without writing anything", async () => {
    const linearClient = fakeLinearClient();
    const results = await auditIssueSpecs([issue({ project: null })], { linearClient, dryRun: true });

    expect(results[0]).toMatchObject({ action: "commented", missing: [expect.stringContaining("no project")] });
    expect(linearClient.comments).toEqual([]);
  });

  it("never mutates anything but a comment, across a whole mixed batch", async () => {
    const linearClient = fakeLinearClient();
    const issues = [
      issue({ id: "id-a", identifier: "MOV-A", project: null }),
      issue({ id: "id-b", identifier: "MOV-B" }),
      issue({ id: "id-c", identifier: "MOV-C", stateName: "Triage", labels: [], project: null }),
      issue({
        id: "id-d",
        identifier: "MOV-D",
        stateName: "Icebox",
        labels: ["human-only", "type:chore", "risk:low", "area:process"],
        project: null,
      }),
    ];

    const results = await auditIssueSpecs(issues, { linearClient });

    expect(results.map((r) => r.action)).toEqual(["commented", "compliant", "exempt", "commented"]);
    expect(linearClient.comments.map((c) => c.issueId)).toEqual(["id-a", "id-d"]);
    // The `human-only` issue is judged by its own kind's rules: `execution:none`
    // and a project, and deliberately no `worker:*`/`model:*` demand.
    expect(linearClient.comments[1].body).toContain("`execution:none`");
    expect(linearClient.comments[1].body).not.toContain("`worker:*`");
    for (const name of ["moveToState", "updateIssuePriority", "addBlocksRelation", "linkBlockingChain"]) {
      expect(linearClient[name], name).not.toHaveBeenCalled();
    }
  });
});

describe("isAuditDue", () => {
  it("is due when never run", () => {
    expect(isAuditDue(undefined, 1_000_000, 60_000)).toBe(true);
    expect(isAuditDue(null, 1_000_000, 60_000)).toBe(true);
  });

  it("is due when non-numeric, so a corrupt record never wedges the schedule shut", () => {
    expect(isAuditDue("not a number", 1_000_000, 60_000)).toBe(true);
    expect(isAuditDue(NaN, 1_000_000, 60_000)).toBe(true);
  });

  it("is not due before the interval elapses, and due exactly at and after it", () => {
    const lastRunAt = 1_000_000;
    const intervalMs = 60_000;
    expect(isAuditDue(lastRunAt, lastRunAt + intervalMs - 1, intervalMs)).toBe(false);
    expect(isAuditDue(lastRunAt, lastRunAt + intervalMs, intervalMs)).toBe(true);
    expect(isAuditDue(lastRunAt, lastRunAt + intervalMs + 1, intervalMs)).toBe(true);
  });
});

describe("IssueSpecAuditScheduleStore", () => {
  let statePath;

  afterEach(() => {
    if (statePath) fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
    statePath = undefined;
  });

  function freshStatePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-issue-spec-audit-"));
    statePath = path.join(dir, "issue-spec-audit-state.json");
    return statePath;
  }

  it("reads {} (never run) when the file does not exist, so a fresh install audits once rather than never", () => {
    const store = new IssueSpecAuditScheduleStore(freshStatePath());
    expect(store.loadOrReset()).toEqual({});
  });

  it("round-trips a saved lastRunAt", () => {
    const store = new IssueSpecAuditScheduleStore(freshStatePath());
    store.save({ lastRunAt: 1_700_000_000_000 });
    expect(store.loadOrReset()).toEqual({ lastRunAt: 1_700_000_000_000 });
  });

  it("reads {} instead of throwing when the primary file is corrupt and no backup exists (AC: one audit, not a crash)", () => {
    const target = freshStatePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ this is not valid json", "utf8");
    const store = new IssueSpecAuditScheduleStore(target);
    expect(store.loadOrReset()).toEqual({});
  });

  it("recovers from the .bak written by a previous save, ahead of throwing (JsonStateStore's own durability contract)", () => {
    const target = freshStatePath();
    const store = new IssueSpecAuditScheduleStore(target);
    store.save({ lastRunAt: 111 });
    store.save({ lastRunAt: 222 });
    fs.writeFileSync(target, "not json at all", "utf8");
    expect(store.loadOrReset()).toEqual({ lastRunAt: 111 });
  });
});
