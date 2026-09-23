// Mocked GitHub/Linear/dispatcher lifecycle for the post-merge master-failure
// observer (MOV-305). Everything here goes through the real policy, the real
// ledger on a real temporary file, and the real issue renderer — only the two
// remote surfaces are faked.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MasterIncidentLedger } from "../src/master-incident-ledger.mjs";
import { evaluateIssueSpec } from "../src/issue-spec.mjs";
import { reconcileMasterIncidents, runMasterCiPass } from "../src/master-ci-observer.mjs";

const REPO = "PelvicSorcerer/moviecal";
const MASTER_SHAS = ["c3", "c2", "bad", "c0"];

let dir;
let statePath;
let linear;

function failedRun(overrides = {}) {
  return {
    databaseId: 4242,
    attempt: 1,
    workflowName: "ios-verify",
    event: "push",
    status: "completed",
    conclusion: "failure",
    headBranch: "master",
    headSha: "bad",
    url: "https://github.test/runs/4242",
    createdAt: "2026-09-23T10:00:00Z",
    jobs: [{ name: "lane-ios", conclusion: "failure" }],
    ...overrides,
  };
}

/** A Linear fake that records every mutation, so "what did it write?" is assertable. */
function fakeLinear() {
  const created = [];
  const comments = [];
  const stateMoves = [];
  const relations = [];
  let nextNumber = 900;
  return {
    created,
    comments,
    stateMoves,
    relations,
    async teamId() {
      return "team-1";
    },
    async issueLabelIds(_teamKey, names) {
      return { ids: Object.fromEntries(names.map((name) => [name, `label-${name}`])), missing: [] };
    },
    async projectByName(name) {
      return {
        id: "project-1",
        name,
        status: "started",
        milestones: [{ id: "milestone-1", name: "Local acceptance & controlled autonomy" }],
      };
    },
    async createIssue(input) {
      const identifier = `MOV-${nextNumber++}`;
      const issue = { id: `linear-${identifier}`, identifier, url: `https://linear.test/${identifier}`, input };
      created.push(issue);
      return issue;
    },
    async addComment(issueId, body) {
      comments.push({ issueId, body });
      return true;
    },
    async moveToState(issueId, stateId) {
      stateMoves.push({ issueId, stateId });
      return true;
    },
    async addRelatedRelation(input) {
      relations.push(input);
      return true;
    },
    async issueByIdentifier(identifier) {
      return { id: `linear-${identifier}`, identifier, url: `https://linear.test/${identifier}`, stateName: "Backlog", stateType: "backlog" };
    },
  };
}

function context(overrides = {}) {
  return {
    enabled: true,
    githubRepo: REPO,
    linearClient: linear,
    teamKey: "MOV",
    ledger: new MasterIncidentLedger(statePath),
    stateIds: { backlog: "state-backlog", needsHumanDecision: "state-nhd", done: "state-done" },
    routeBudget: 1,
    maxLineageDistance: 10,
    projectName: "Autonomous local-agent delivery",
    milestoneName: "Local acceptance & controlled autonomy",
    listMasterRunsFn: () => [failedRun()],
    describeMasterRunFn: () => failedRun(),
    pullRequestsForCommitFn: () => [{ number: 602, url: "https://github.test/pull/602", body: "Linear: MOV-293" }],
    masterCommitLineageFn: () => [...MASTER_SHAS],
    findMergedFixPullRequestFn: () => null,
    latestSuccessfulMasterRunFn: () => null,
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-ci-observer-"));
  statePath = path.join(dir, "master-incidents.json");
  linear = fakeLinear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("one deterministic master failure (MOV-305)", () => {
  it("creates exactly one fully specced remediation issue and routes it for an ordinary fix PR", async () => {
    const ctx = context();
    const [result] = await runMasterCiPass(ctx);

    expect(result.outcome).toBe("routed");
    expect(linear.created).toHaveLength(1);
    const [issue] = linear.created;
    expect(issue.input.stateId).toBe("state-backlog");
    expect(issue.input.projectId).toBe("project-1");
    expect(issue.input.projectMilestoneId).toBe("milestone-1");

    // The filed issue is complete by the real validator's own rules.
    expect(
      evaluateIssueSpec({
        stateName: "Backlog",
        labels: issue.input.labelIds.map((id) => id.replace(/^label-/, "")),
        project: "Autonomous local-agent delivery",
        projectStatus: "started",
        projectMilestoneCount: 1,
        milestone: "Local acceptance & controlled autonomy",
        description: issue.input.description,
      }).missing,
    ).toEqual([]);

    // Routed, not moved out of Backlog: the ordinary promoter owns that.
    expect(linear.stateMoves).toEqual([]);
    const incident = new MasterIncidentLedger(statePath).get(result.key);
    expect(incident.status).toBe("routed");
    expect(incident.evidence).toMatchObject({ runId: 4242, headSha: "bad", prNumber: 602, sourceIssue: "MOV-293", classification: "code-test" });
  });

  it("links and notifies the source Linear issue exactly once", async () => {
    const ctx = context();
    await runMasterCiPass(ctx);
    await runMasterCiPass(context({ ledger: new MasterIncidentLedger(statePath) }));
    expect(linear.relations).toHaveLength(1);
    expect(linear.comments.filter((comment) => comment.issueId === "linear-MOV-293")).toHaveLength(1);
  });

  it("treats a lane-ios master failure exactly as it treats any other lane", async () => {
    const iosResult = (await runMasterCiPass(context()))[0];
    fs.rmSync(statePath, { force: true });
    linear = fakeLinear();
    const unitResult = (
      await runMasterCiPass(
        context({
          listMasterRunsFn: () => [failedRun({ workflowName: "verify", jobs: [{ name: "lane-unit", conclusion: "failure" }] })],
          describeMasterRunFn: () => failedRun({ workflowName: "verify", jobs: [{ name: "lane-unit", conclusion: "failure" }] }),
        }),
      )
    )[0];
    expect(unitResult.outcome).toBe(iosResult.outcome);
    expect(unitResult.outcome).toBe("routed");
  });
});

describe("replay and restart idempotency (MOV-305)", () => {
  it("updates the original record instead of duplicating issues, comments, or routes", async () => {
    await runMasterCiPass(context());
    // Simulated daemon restart: brand new ledger instance over the same file.
    await runMasterCiPass(context({ ledger: new MasterIncidentLedger(statePath) }));
    await runMasterCiPass(context({ ledger: new MasterIncidentLedger(statePath) }));

    expect(linear.created).toHaveLength(1);
    const remediationId = linear.created[0].id;
    expect(linear.comments.filter((comment) => comment.issueId === remediationId)).toHaveLength(1);
    const incident = new MasterIncidentLedger(statePath).get("master-ci:4242:1:bad");
    expect(incident.observationCount).toBe(3);
    expect(incident.status).toBe("routed");
  });

  it("does not read its own spent budget as exhaustion and re-escalate a routed incident", async () => {
    await runMasterCiPass(context());
    const [replay] = await runMasterCiPass(context({ ledger: new MasterIncidentLedger(statePath) }));
    expect(replay.outcome).toBe("already-routed");
    expect(linear.stateMoves).toEqual([]);
    expect(new MasterIncidentLedger(statePath).get(replay.key).status).toBe("routed");
  });

  it("never silently re-routes an escalated incident once budget frees up", async () => {
    const infra = failedRun({ conclusion: "startup_failure" });
    await runMasterCiPass(context({ listMasterRunsFn: () => [infra], describeMasterRunFn: () => infra }));
    const [replay] = await runMasterCiPass(
      context({ ledger: new MasterIncidentLedger(statePath), routeBudget: 99, listMasterRunsFn: () => [infra], describeMasterRunFn: () => infra }),
    );
    expect(replay.outcome).toBe("already-needs-human-decision");
    expect(linear.stateMoves).toHaveLength(1);
  });

  it("treats a second attempt of the same run as its own incident", async () => {
    await runMasterCiPass(context());
    await runMasterCiPass(
      context({
        ledger: new MasterIncidentLedger(statePath),
        routeBudget: 5,
        listMasterRunsFn: () => [failedRun({ attempt: 2 })],
        describeMasterRunFn: () => failedRun({ attempt: 2 }),
      }),
    );
    expect(linear.created).toHaveLength(2);
    expect(new MasterIncidentLedger(statePath).all().map((incident) => incident.key).sort()).toEqual([
      "master-ci:4242:1:bad",
      "master-ci:4242:2:bad",
    ]);
  });
});

describe("failures that must stop for a human (MOV-305)", () => {
  it("escalates an infrastructure failure with the evidence and the next decision", async () => {
    const infra = failedRun({ conclusion: "startup_failure" });
    const [result] = await runMasterCiPass(context({ listMasterRunsFn: () => [infra], describeMasterRunFn: () => infra }));

    expect(result.outcome).toBe("needs-human-decision");
    expect(linear.created).toHaveLength(1);
    expect(linear.stateMoves).toEqual([{ issueId: linear.created[0].id, stateId: "state-nhd" }]);
    const comment = linear.comments.find((entry) => entry.issueId === linear.created[0].id).body;
    expect(comment).toContain("https://github.test/runs/4242");
    expect(comment).toContain("bad");
    expect(comment).toContain("infrastructure-transient");
    expect(comment).toMatch(/Next required human decision:/);
    expect(new MasterIncidentLedger(statePath).get(result.key).status).toBe("needs-human-decision");
  });

  it("escalates an ambiguous attribution without guessing a source", async () => {
    const [result] = await runMasterCiPass(
      context({ pullRequestsForCommitFn: () => [{ number: 1 }, { number: 2 }] }),
    );
    expect(result.outcome).toBe("needs-human-decision");
    expect(result.reason).toMatch(/#1, #2/);
    expect(linear.relations).toEqual([]);
  });

  it("escalates a stale lineage rather than branching a fix from unrelated code", async () => {
    const [result] = await runMasterCiPass(context({ masterCommitLineageFn: () => ["c3", "c2"] }));
    expect(result.outcome).toBe("needs-human-decision");
    expect(result.reason).toMatch(/stale or rewritten/);
  });

  it("escalates a production/migration lane unconditionally", async () => {
    const sensitive = failedRun({ workflowName: "supabase-verify", jobs: [{ name: "lane-migrate-prod", conclusion: "failure" }] });
    const [result] = await runMasterCiPass(context({ listMasterRunsFn: () => [sensitive], describeMasterRunFn: () => sensitive }));
    expect(result.outcome).toBe("needs-human-decision");
    expect(result.reason).toMatch(/production, migration, or credential/);
  });

  it("escalates once the automatic remediation budget is spent", async () => {
    await runMasterCiPass(context());
    const second = failedRun({ databaseId: 5555, headSha: "c2" });
    const [result] = await runMasterCiPass(
      context({ ledger: new MasterIncidentLedger(statePath), listMasterRunsFn: () => [second], describeMasterRunFn: () => second }),
    );
    expect(result.outcome).toBe("needs-human-decision");
    expect(result.reason).toMatch(/budget is exhausted/);
  });

  it("escalates when the remediation issue itself cannot be created", async () => {
    linear.createIssue = async () => {
      throw new Error("Linear labels are missing from the workspace: execution:mac");
    };
    const ctx = context();
    const [result] = await runMasterCiPass(ctx);
    expect(result.outcome).toBe("incident-creation-failed");
    // The observation still survives, so a later pass finishes the job.
    const incident = new MasterIncidentLedger(statePath).get(result.key);
    expect(incident.status).toBe("needs-human-decision");
    expect(incident.evidence.runId).toBe(4242);
    expect(incident.remediation).toBeNull();
  });
});

describe("runs that are not master incidents (MOV-305)", () => {
  it.each([
    ["a successful run", { conclusion: "success" }],
    ["a cancelled run", { conclusion: "cancelled" }],
    ["a still-running run", { status: "in_progress", conclusion: "" }],
    ["a manually dispatched run", { event: "workflow_dispatch" }],
    ["a scheduled run", { event: "schedule" }],
    ["a pull-request run", { event: "pull_request", headBranch: "agent/MOV-1-x" }],
    ["a non-master run", { headBranch: "agent/MOV-1-x" }],
    ["a fork run", { head_repository: { full_name: "someone-else/moviecal" } }],
  ])("creates no incident for %s", async (_label, overrides) => {
    const candidate = failedRun(overrides);
    const [result] = await runMasterCiPass(
      context({ listMasterRunsFn: () => [candidate], describeMasterRunFn: () => candidate }),
    );
    expect(result.outcome).toBe("not-a-master-incident");
    expect(linear.created).toEqual([]);
    expect(fs.existsSync(statePath)).toBe(false);
  });
});

describe("post-fix reconciliation (MOV-305)", () => {
  async function routedIncident() {
    await runMasterCiPass(context());
    return new MasterIncidentLedger(statePath);
  }

  it("completes only after the fix PR merged and the lane passed on a newer master SHA", async () => {
    const ledger = await routedIncident();
    const identifier = linear.created[0].identifier;
    const [result] = await reconcileMasterIncidents(
      context({
        ledger,
        findMergedFixPullRequestFn: () => ({ number: 700, url: "https://github.test/pull/700" }),
        latestSuccessfulMasterRunFn: () => ({ headSha: "c3", url: "https://github.test/runs/9000" }),
      }),
    );
    expect(result.outcome).toBe("reconciled");
    expect(result.issue).toBe(identifier);
    expect(linear.stateMoves).toContainEqual({ issueId: linear.created[0].id, stateId: "state-done" });
    const incident = ledger.get(result.key);
    expect(incident.status).toBe("reconciled");
    expect(incident.evidence.headSha).toBe("bad");
    expect(incident.reconciliation).toMatchObject({ prNumber: 700, verifiedSha: "c3" });
  });

  it("does not complete on a green re-run of the original SHA", async () => {
    const ledger = await routedIncident();
    const [result] = await reconcileMasterIncidents(
      context({
        ledger,
        findMergedFixPullRequestFn: () => ({ number: 700 }),
        latestSuccessfulMasterRunFn: () => ({ headSha: "bad" }),
      }),
    );
    expect(result.outcome).toBe("still-open");
    expect(result.reason).toMatch(/green re-run on the original SHA/);
    expect(ledger.get(result.key).status).toBe("routed");
  });

  it("does not complete while no fix PR has merged", async () => {
    const ledger = await routedIncident();
    const [result] = await reconcileMasterIncidents(context({ ledger }));
    expect(result.outcome).toBe("still-open");
    expect(result.reason).toMatch(/no merged fix pull request/);
  });

  it("names what a bounded reconciliation pass did not cover, rather than capping silently", async () => {
    const ledger = await routedIncident();
    ledger.observe("extra", {});
    ledger.attachRemediation("extra", { id: "linear-extra", identifier: "MOV-998" });
    ledger.setStatus("extra", "needs-human-decision");

    const results = await reconcileMasterIncidents(context({ ledger, reconcileLimit: 1 }));
    const deferred = results.find((result) => result.outcome === "deferred");
    expect(deferred).toBeTruthy();
    expect(deferred.reason).toMatch(/1 further open incident/);
    expect(results.filter((result) => result.outcome === "still-open")).toHaveLength(1);
  });

  it("is idempotent once reconciled, and never re-observes the closed incident", async () => {
    const ledger = await routedIncident();
    const reconcileCtx = context({
      ledger,
      findMergedFixPullRequestFn: () => ({ number: 700 }),
      latestSuccessfulMasterRunFn: () => ({ headSha: "c3" }),
    });
    await reconcileMasterIncidents(reconcileCtx);
    const commentsAfterFirst = linear.comments.length;
    await reconcileMasterIncidents(context({ ...reconcileCtx, ledger: new MasterIncidentLedger(statePath) }));
    expect(linear.comments).toHaveLength(commentsAfterFirst);

    const [observed] = await runMasterCiPass(context({ ledger: new MasterIncidentLedger(statePath) }));
    expect(observed.outcome).toBe("already-reconciled");
    expect(linear.created).toHaveLength(1);
  });
});

describe("disablement (MOV-305)", () => {
  it("reads nothing and writes nothing while the observer is off", async () => {
    let read = false;
    const ctx = context({
      enabled: false,
      listMasterRunsFn: () => {
        read = true;
        return [failedRun()];
      },
      masterCommitLineageFn: () => {
        read = true;
        return MASTER_SHAS;
      },
    });
    expect(await runMasterCiPass(ctx)).toEqual([{ outcome: "disabled", reason: "MOVIECAL_MASTER_CI_OBSERVER is not enabled" }]);
    expect(await reconcileMasterIncidents(ctx)).toEqual([]);
    expect(read).toBe(false);
    expect(linear.created).toEqual([]);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("previews without writing to Linear or the ledger in dry-run", async () => {
    const [result] = await runMasterCiPass(context({ dryRun: true }));
    expect(result.outcome).toBe("would-route-fix-pr");
    expect(linear.created).toEqual([]);
    expect(linear.comments).toEqual([]);
    expect(fs.existsSync(statePath)).toBe(false);
  });
});
