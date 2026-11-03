// MOV-502: one escalation helper and a
// static guard that no other module moves an issue into a needs-state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecyclePublisher } from "../src/agent-lifecycle.mjs";
import {
  OwnerNotificationLedger,
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

function fakeClient() {
  const log = [];
  return {
    log,
    async moveToState(issueId, stateId) { log.push({ type: "move", issueId, stateId }); return true; },
    async addComment(issueId, body) { log.push({ type: "comment", issueId, body }); return true; },
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
    expect(client.log.map((entry) => entry.type)).toEqual(["comment", "move"]);
    expect(client.log[1]).toMatchObject({ issueId: "id-1", stateId: "state-nhd" });
    expect(client.log[0].body).toBe([
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

  it("does not move the issue when the mention comment fails", async () => {
    const client = fakeClient();
    client.addComment = async () => { throw new Error("linear down"); };
    await expect(escalateToOwner({ linearClient: client, issue: ISSUE, stateId: "s", ask: "a", evidence: "e", logger: SILENT })).rejects.toThrow("linear down");
    expect(client.log.filter((entry) => entry.type === "move")).toEqual([]);
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
    expect(client.log.map((entry) => entry.type)).toEqual(["comment", "move"]);
    expect(client.log[0].body).not.toContain("linear.app");
    expect(client.log[0].body.startsWith("Needs you: a")).toBe(true);
    expect(warnings[0]).toContain("without an @mention");
  });

  it("looks the assignee up when the caller only knows the issue id", async () => {
    const client = fakeClient();
    client.issueSnapshot = async () => ISSUE;
    await escalateToOwner({ linearClient: client, issue: { id: "id-1", identifier: "MOV-1" }, stateId: "s", ask: "a", evidence: "e", logger: SILENT });
    expect(client.log[0].body).toContain("https://linear.app/moviecal/profiles/adam");
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

  it("does not re-mention the same event after a restart (new publisher, same ledger)", async () => {
    const client = fakeClient();
    const make = () => new LifecyclePublisher({
      linearClient: client, logger: SILENT, needsStateIds: ["state-nhd"], escalationLedger: ledger,
      context: { issue: ISSUE },
    });
    await make().publish("error", { stateId: "state-nhd", summary: "worker failed" });
    await make().publish("error", { stateId: "state-nhd", summary: "worker failed" });
    expect(client.log.filter((entry) => entry.type === "comment")).toHaveLength(1);
    expect(client.log.filter((entry) => entry.type === "move")).toHaveLength(1);
  });

  it("stays retryable when the escalation throws", async () => {
    const client = fakeClient();
    let fail = true;
    const addComment = client.addComment;
    client.addComment = async (...args) => { if (fail) { fail = false; throw new Error("linear down"); } return addComment(...args); };
    const publisher = new LifecyclePublisher({
      linearClient: client, logger: SILENT, needsStateIds: ["state-nhd"], escalationLedger: ledger,
      context: { issue: ISSUE },
    });
    await expect(publisher.publish("error", { stateId: "state-nhd", summary: "worker failed" })).rejects.toThrow("linear down");
    await publisher.publish("error", { stateId: "state-nhd", summary: "worker failed" });
    expect(client.log.filter((entry) => entry.type === "comment")).toHaveLength(1);
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
