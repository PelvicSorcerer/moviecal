// MOV-502: one escalation helper, owner unsubscribe-once bookkeeping, and a
// static guard that no other module moves an issue into a needs-state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteEligible } from "../src/promoter.mjs";
import { LifecyclePublisher } from "../src/agent-lifecycle.mjs";
import {
  OwnerNotificationLedger,
  ensureOwnerUnsubscribed,
  escalateToOwner,
  ownerMention,
  renderEscalationComment,
} from "../src/owner-escalation.mjs";

const SILENT = { warn() {}, error() {}, log() {} };
const ISSUE = {
  id: "id-1",
  identifier: "MOV-1",
  url: "https://linear.app/moviecal/issue/MOV-1/x",
  assignee: { id: "user-adam", name: "Adam Moore", displayName: "adam" },
};

function fakeClient({ unsubscribe = async () => true } = {}) {
  const log = [];
  return {
    log,
    async moveToState(issueId, stateId) { log.push({ type: "move", issueId, stateId }); return true; },
    async addComment(issueId, body) { log.push({ type: "comment", issueId, body }); return true; },
    async unsubscribeFromIssue(issueId, userId) { log.push({ type: "unsubscribe", issueId, userId }); return unsubscribe(); },
  };
}

let dir;
let ledger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-escalation-"));
  ledger = new OwnerNotificationLedger(path.join(dir, "state.json"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("escalateToOwner", () => {
  it("moves the state and posts one comment that leads with 'Needs you:' and mentions the assignee", async () => {
    const client = fakeClient();
    const result = await escalateToOwner({
      linearClient: client, issue: ISSUE, stateId: "state-nhd", ask: "decide on PR #7",
      evidence: "**Evidence line**", options: ["Run `dispatcher resume MOV-1`."], logger: SILENT,
    });
    expect(result).toMatchObject({ escalated: true, mentioned: true });
    expect(client.log.map((entry) => entry.type)).toEqual(["move", "comment"]);
    expect(client.log[0]).toMatchObject({ issueId: "id-1", stateId: "state-nhd" });
    expect(client.log[1].body).toBe([
      "Needs you: decide on PR #7",
      "",
      "https://linear.app/moviecal/profiles/adam",
      "",
      "**Evidence line**",
      "",
      "**What you can do next**",
      "- Run `dispatcher resume MOV-1`.",
    ].join("\n"));
  });

  it("is idempotent per escalation key", async () => {
    const client = fakeClient();
    const args = { linearClient: client, issue: ISSUE, stateId: "s", ask: "a", evidence: "e", key: "k1", ledger, logger: SILENT };
    expect((await escalateToOwner(args)).escalated).toBe(true);
    expect(await escalateToOwner(args)).toMatchObject({ escalated: false, reason: "already escalated" });
    expect(client.log).toHaveLength(2);
    expect((await escalateToOwner({ ...args, key: "k2" })).escalated).toBe(true);
  });

  it.each([
    ["no assignee", { ...ISSUE, assignee: null }, []],
    ["an app assignee", { ...ISSUE, assignee: { ...ISSUE.assignee, isApp: true } }, []],
    ["the dispatcher's own user", ISSUE, ["user-adam"]],
  ])("still moves state and comments, without a mention, for %s", async (_name, issue, botUserIds) => {
    const client = fakeClient();
    const warnings = [];
    const result = await escalateToOwner({
      linearClient: client, issue, stateId: "s", ask: "a", evidence: "e", botUserIds,
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(result.mentioned).toBe(false);
    expect(client.log.map((entry) => entry.type)).toEqual(["move", "comment"]);
    expect(client.log[1].body).not.toContain("linear.app");
    expect(client.log[1].body.startsWith("Needs you: a")).toBe(true);
    expect(warnings[0]).toContain("without an @mention");
  });

  it("looks the assignee up when the caller only knows the issue id", async () => {
    const client = fakeClient();
    client.issueSnapshot = async () => ISSUE;
    await escalateToOwner({ linearClient: client, issue: { id: "id-1", identifier: "MOV-1" }, stateId: "s", ask: "a", evidence: "e", logger: SILENT });
    expect(client.log[1].body).toContain("https://linear.app/moviecal/profiles/adam");
  });

  it("collapses a multi-line ask onto the first line", () => {
    expect(renderEscalationComment({ ask: "a\n b", evidence: "e", options: [], mention: null }).split("\n")[0]).toBe("Needs you: a b");
  });

  it("needs the workspace in the issue URL to build a mention", () => {
    expect(ownerMention({ ...ISSUE, url: undefined })).toMatchObject({ mention: null });
  });
});

describe("LifecyclePublisher needs-state moves", () => {
  it("routes a needs-state publish through the helper, and other states stay mention-free", async () => {
    const client = fakeClient();
    const publisher = new LifecyclePublisher({
      linearClient: client, logger: SILENT, needsStateIds: ["state-nhd"],
      context: { issue: ISSUE },
    });
    await publisher.publish("error", { stateId: "state-nhd", summary: "worker failed" });
    await publisher.publish("progress", { stateId: "state-working", summary: "working", action: "Working" });
    const comments = client.log.filter((entry) => entry.type === "comment");
    expect(comments).toHaveLength(2);
    expect(comments[0].body.startsWith("Needs you: worker failed")).toBe(true);
    expect(comments[0].body).toContain("https://linear.app/moviecal/profiles/adam");
    expect(comments[1].body).not.toContain("linear.app/moviecal/profiles");
    await expect(publisher.moveState("state-nhd")).rejects.toThrow(/needs-state/);
  });
});

describe("ensureOwnerUnsubscribed", () => {
  it("unsubscribes once per issue and never again", async () => {
    const client = fakeClient();
    const args = { linearClient: client, issue: ISSUE, ledger, logger: SILENT };
    expect((await ensureOwnerUnsubscribed(args)).unsubscribed).toBe(true);
    await ensureOwnerUnsubscribed(args);
    await ensureOwnerUnsubscribed({ ...args, ledger: new OwnerNotificationLedger(ledger.statePath) });
    expect(client.log.filter((entry) => entry.type === "unsubscribe")).toEqual([{ type: "unsubscribe", issueId: "id-1", userId: "user-adam" }]);
  });

  it("records a refusal, logs it once and does not throw or retry", async () => {
    const client = fakeClient({ unsubscribe: async () => { throw new Error("forbidden"); } });
    const warnings = [];
    const args = { linearClient: client, issue: ISSUE, ledger, logger: { warn: (message) => warnings.push(message) } };
    expect((await ensureOwnerUnsubscribed(args)).unsubscribed).toBe(false);
    await ensureOwnerUnsubscribed(args);
    expect(client.log).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(ledger.load().unsubscribed["id-1"]).toMatchObject({ outcome: "refused", detail: "forbidden" });
  });

  it("skips an issue with no human assignee", async () => {
    const client = fakeClient();
    await ensureOwnerUnsubscribed({ linearClient: client, issue: { ...ISSUE, assignee: null }, ledger, logger: SILENT });
    expect(client.log).toEqual([]);
  });

  it("promotion then claim unsubscribes exactly once", async () => {
    const client = fakeClient();
    const unassigned = {
      id: "id-1", identifier: "MOV-1", stateName: "Backlog", labels: [], blockedByIds: [], recentComments: [], assignee: null,
      description: ["## Acceptance criteria", "- it works.", "", "### Testing Expectations", "- unit: covers it."].join("\n"),
    };
    const ownerAssignment = {
      ensureOwner: async () => ({ ok: true, assigned: true, wouldAssign: false, member: { id: "user-adam", name: "Adam Moore" } }),
    };
    await promoteEligible([unassigned], {
      linearClient: client, readyForAgentStateId: "ready", isBlockerSatisfied: () => true, ownerAssignment,
      ownerUnsubscribe: (issue) => ensureOwnerUnsubscribed({ linearClient: client, issue, ledger, logger: SILENT }),
    });
    await ensureOwnerUnsubscribed({ linearClient: client, issue: ISSUE, ledger, logger: SILENT });
    expect(client.log.filter((entry) => entry.type === "unsubscribe")).toHaveLength(1);
  });
});

describe("single escalation path", () => {
  it("no module outside owner-escalation.mjs moves an issue directly into a needs-state", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files = [];
    for (const sub of ["src", "bin"]) {
      for (const name of fs.readdirSync(path.join(root, sub))) if (name.endsWith(".mjs")) files.push(path.join(root, sub, name));
    }
    const direct = /moveToState\([^)]*(needsHumanDecision|needsInput|NeedsHumanDecision|NeedsInput)/i;
    const offenders = files.filter((file) => direct.test(fs.readFileSync(file, "utf8"))).map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("no module outside the helper builds a user mention", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const offenders = [];
    for (const sub of ["src", "bin"]) {
      for (const name of fs.readdirSync(path.join(root, sub))) {
        if (name.endsWith(".mjs") && name !== "owner-escalation.mjs" && /linear\.app\/[^"'`]*\/profiles\//.test(fs.readFileSync(path.join(root, sub, name), "utf8"))) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
