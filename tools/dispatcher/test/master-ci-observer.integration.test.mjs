import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MasterIncidentLedger } from "../src/master-incident-ledger.mjs";
import { reconcileMasterIncidents, runMasterCiPass } from "../src/master-ci-observer.mjs";

let directory;
let ledger;

const RUN = {
  databaseId: 42, attempt: 1, event: "push", status: "completed", conclusion: "failure",
  headBranch: "master", headSha: "bad", workflowName: "verify", url: "https://example.test/run/42",
  createdAt: "2026-09-23T00:00:00Z", jobs: [{ name: "lane-unit", conclusion: "failure", summary: "test failed" }],
};

function client() {
  const calls = [];
  return {
    calls,
    async teamId() { return "team"; },
    async issueLabelIds(_team, labels) { return { ids: Object.fromEntries(labels.map((label) => [label, label])), missing: [] }; },
    async projectByName() { return { id: "project", name: "Project", status: "started", milestones: [{ id: "milestone", name: "Milestone" }] }; },
    async createIssue(input) { calls.push({ type: "create", input }); return { id: "remediation", identifier: "MOV-999", url: "https://linear.test/MOV-999" }; },
    async issueByIdentifier(identifier) { return identifier === "MOV-111" ? { id: "source", identifier, stateType: "completed" } : { id: "remediation", identifier, stateType: "started" }; },
    async addRelatedRelation(input) { calls.push({ type: "related", input }); return true; },
    async addComment(id, body) { calls.push({ type: "comment", id, body }); return true; },
    async moveToState(id, state) { calls.push({ type: "state", id, state }); return true; },
  };
}

function context(overrides = {}) {
  return {
    enabled: true, githubRepo: "owner/repo", linearClient: client(), teamKey: "MOV", ledger,
    stateIds: { backlog: "backlog", needsHumanDecision: "human", done: "done" }, workflows: ["verify"],
    routeBudget: 1, projectName: "Project", milestoneName: "Milestone",
    listMasterRunsFn: () => [RUN], describeMasterRunFn: () => RUN,
    pullRequestsForCommitFn: () => [{ number: 7, url: "https://example.test/pr/7", body: "Fixes MOV-111" }],
    masterCommitLineageFn: () => ["current", "bad"],
    findMergedFixPullRequestFn: () => null, latestSuccessfulMasterRunFn: () => null,
    now: () => new Date("2026-09-23T01:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "master-ci-observer-")); ledger = new MasterIncidentLedger(path.join(directory, "ledger.json")); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("master CI observer lifecycle (MOV-316)", () => {
  it("creates one fully specified remediation and routes it once", async () => {
    const ctx = context();
    expect(await runMasterCiPass(ctx)).toMatchObject([{ outcome: "routed", issue: "MOV-999" }]);
    expect(ctx.linearClient.calls.filter((call) => call.type === "create")).toHaveLength(1);
    expect(ctx.linearClient.calls.filter((call) => call.type === "related")).toHaveLength(1);
    expect(ctx.linearClient.calls.filter((call) => call.type === "comment")).toHaveLength(2);
    expect(ledger.open()).toMatchObject([{ status: "routed", remediation: { identifier: "MOV-999" } }]);
    expect(await runMasterCiPass(ctx)).toMatchObject([{ outcome: "already-routed" }]);
    expect(ctx.linearClient.calls.filter((call) => call.type === "create")).toHaveLength(1);
    expect(ctx.linearClient.calls.filter((call) => call.type === "comment")).toHaveLength(2);
  });

  it("moves infrastructure and ambiguous failures to Needs Human Decision without routing", async () => {
    const infrastructure = context({ describeMasterRunFn: () => ({ ...RUN, jobs: [{ name: "lane-unit", conclusion: "timed_out" }] }) });
    expect(await runMasterCiPass(infrastructure)).toMatchObject([{ outcome: "needs-human-decision" }]);
    expect(infrastructure.linearClient.calls.filter((call) => call.type === "state")).toEqual([{ type: "state", id: "remediation", state: "human" }]);
    const ambiguous = context({ ledger: new MasterIncidentLedger(path.join(directory, "other.json")), pullRequestsForCommitFn: () => [] });
    expect(await runMasterCiPass(ambiguous)).toMatchObject([{ outcome: "needs-human-decision" }]);
  });

  it("reconciles only after a linked fix merges and the named lane passes on a newer master SHA", async () => {
    const ctx = context();
    await runMasterCiPass(ctx);
    ctx.findMergedFixPullRequestFn = () => ({ number: 8, url: "https://example.test/pr/8" });
    ctx.latestSuccessfulMasterRunFn = () => ({ headSha: "current", url: "https://example.test/run/43" });
    expect(await reconcileMasterIncidents(ctx)).toMatchObject([{ outcome: "reconciled", issue: "MOV-999" }]);
    expect(ledger.open()).toHaveLength(0);
    expect(ctx.linearClient.calls.filter((call) => call.type === "state")).toContainEqual({ type: "state", id: "remediation", state: "done" });
  });

  it("does not reconcile a successful rerun of the original failed SHA", async () => {
    const ctx = context();
    await runMasterCiPass(ctx);
    ctx.findMergedFixPullRequestFn = () => ({ number: 8 });
    ctx.latestSuccessfulMasterRunFn = () => ({ headSha: "bad" });
    expect(await reconcileMasterIncidents(ctx)).toMatchObject([{ outcome: "still-open", reason: expect.stringMatching(/same commit/) }]);
    expect(ledger.open()).toHaveLength(1);
  });
});
