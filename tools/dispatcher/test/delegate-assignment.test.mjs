import { describe, it, expect, vi } from "vitest";
import { needsDelegateAssignment, createDelegateAssigner } from "../src/delegate-assignment.mjs";
import { promoteEligible, PROMOTION_COMMENT } from "../src/promoter.mjs";

const ACTOR = "dbbee117-9097-4797-b1e5-00169d6bc296";
const READY = ["## Acceptance criteria", "- it works.", "", "### Testing Expectations", "- unit: covers it."].join("\n");

function issue(overrides = {}) {
  return {
    id: "id-1",
    identifier: "MOV-1",
    stateName: "Backlog",
    description: READY,
    labels: ["execution:mac"],
    blockedByIds: [],
    recentComments: [],
    assignee: { id: "user-1" },
    delegate: null,
    ...overrides,
  };
}

describe("needsDelegateAssignment", () => {
  it("is true for a single execution:mac route with no delegate", () => {
    expect(needsDelegateAssignment(issue())).toBe(true);
  });
  it("never overwrites any existing delegate", () => {
    expect(needsDelegateAssignment(issue({ delegate: { id: ACTOR, name: "moviecal-dispatcher" } }))).toBe(false);
    expect(needsDelegateAssignment(issue({ delegate: { id: "other", name: "someone" } }))).toBe(false);
  });
  it.each([
    [["execution:cloud"]],
    [["execution:none"]],
    [[]],
    [["execution:mac", "execution:cloud"]],
    [["type:coordination", "execution:mac"]],
  ])("is false for labels %j", (labels) => {
    expect(needsDelegateAssignment(issue({ labels }))).toBe(false);
  });
});

describe("createDelegateAssigner", () => {
  it("writes and verifies on readback", async () => {
    const linearClient = { delegateIssue: vi.fn(async (_i, id) => ({ success: true, delegateId: id })) };
    const out = await createDelegateAssigner({ linearClient, delegate: { id: ACTOR } }).ensureDelegate(issue());
    expect(out).toMatchObject({ ok: true, delegated: true });
    expect(linearClient.delegateIssue).toHaveBeenCalledWith("id-1", ACTOR);
  });
  it("dry-run plans without writing", async () => {
    const linearClient = { delegateIssue: vi.fn() };
    const out = await createDelegateAssigner({ linearClient, delegate: { id: ACTOR } }).ensureDelegate(issue(), { dryRun: true });
    expect(out).toMatchObject({ ok: true, wouldDelegate: true, delegated: false });
    expect(linearClient.delegateIssue).not.toHaveBeenCalled();
  });
  it("resolves an app name to the actor UUID before writing", async () => {
    const linearClient = {
      appActorByName: vi.fn(async () => ({ id: ACTOR })),
      delegateIssue: vi.fn(async (_i, id) => ({ success: true, delegateId: id })),
    };
    const assigner = createDelegateAssigner({ linearClient, delegate: { id: "moviecal-dispatcher", name: "moviecal-dispatcher" } });
    expect(await assigner.ensureDelegate(issue())).toMatchObject({ ok: true, delegated: true });
    expect(linearClient.appActorByName).toHaveBeenCalledWith("moviecal-dispatcher");
    expect(linearClient.delegateIssue).toHaveBeenCalledWith("id-1", ACTOR);
    await assigner.ensureDelegate(issue({ id: "id-2" }));
    expect(linearClient.appActorByName).toHaveBeenCalledTimes(1);
  });
  it("looks up by delegate name when no id is configured, including in dry run", async () => {
    const linearClient = { appActorByName: vi.fn(async () => ({ id: ACTOR })), delegateIssue: vi.fn() };
    const out = await createDelegateAssigner({ linearClient, delegate: { id: null, name: "moviecal-dispatcher" } }).ensureDelegate(issue(), { dryRun: true });
    expect(out).toMatchObject({ ok: true, wouldDelegate: true });
    expect(linearClient.appActorByName).toHaveBeenCalledWith("moviecal-dispatcher");
    expect(linearClient.delegateIssue).not.toHaveBeenCalled();
  });
  it("does not look up when the configured id is a UUID", async () => {
    const linearClient = { appActorByName: vi.fn(), delegateIssue: async (_i, id) => ({ success: true, delegateId: id }) };
    await createDelegateAssigner({ linearClient, delegate: { id: ACTOR } }).ensureDelegate(issue());
    expect(linearClient.appActorByName).not.toHaveBeenCalled();
  });
  it.each([
    ["no match", async () => ({ id: null, reason: "no active app user" })],
    ["a non-UUID result", async () => ({ id: "moviecal-dispatcher" })],
    ["a thrown error", async () => { throw new Error("net down"); }],
  ])("fails closed when the lookup gives %s", async (_n, appActorByName) => {
    const linearClient = { appActorByName, delegateIssue: vi.fn() };
    const out = await createDelegateAssigner({ linearClient, delegate: { id: "moviecal-dispatcher" } }).ensureDelegate(issue());
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/actor id/);
    expect(linearClient.delegateIssue).not.toHaveBeenCalled();
  });
  it("rejects a bare success whose readback differs", async () => {
    const linearClient = { delegateIssue: async () => ({ success: true, delegateId: null }) };
    const out = await createDelegateAssigner({ linearClient, delegate: { id: ACTOR } }).ensureDelegate(issue());
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/readback/) });
  });
  it("turns a thrown error into a hold, then retries successfully", async () => {
    let fail = true;
    const linearClient = {
      delegateIssue: async (_i, id) => {
        if (fail) throw new Error("boom");
        return { success: true, delegateId: id };
      },
    };
    const assigner = createDelegateAssigner({ linearClient, delegate: { id: ACTOR } });
    expect(await assigner.ensureDelegate(issue())).toMatchObject({ ok: false, reason: expect.stringMatching(/boom/) });
    fail = false;
    expect(await assigner.ensureDelegate(issue())).toMatchObject({ ok: true, delegated: true });
  });
});

function client() {
  const log = [];
  return {
    log,
    async delegateIssue(issueId, delegateId) {
      log.push({ type: "delegateIssue", issueId, delegateId });
      return { success: true, delegateId };
    },
    async moveToState(issueId, stateId) {
      log.push({ type: "moveToState", issueId, stateId });
    },
    async addComment(issueId, body) {
      log.push({ type: "addComment", issueId, body });
    },
  };
}

describe("promoteEligible with delegateAssignment", () => {
  const run = (issues, linearClient, extra = {}) =>
    promoteEligible(issues, {
      linearClient,
      readyForAgentStateId: "state-ready",
      isBlockerSatisfied: () => true,
      delegateAssignment: createDelegateAssigner({ linearClient, delegate: { id: ACTOR } }),
      ...extra,
    });

  it("delegates after the owner step and before the transition", async () => {
    const c = client();
    const order = [];
    const ownerAssignment = {
      ensureOwner: async () => {
        order.push("owner");
        c.log.push({ type: "assignIssue" });
        return { ok: true, assigned: true, member: { name: "Adam" } };
      },
    };
    const results = await run([issue({ assignee: null })], c, { ownerAssignment });
    expect(results[0]).toMatchObject({ promoted: true, delegateAssigned: true });
    expect(c.log.map((e) => e.type)).toEqual(["assignIssue", "delegateIssue", "moveToState", "addComment"]);
    expect(c.log.at(-1).body).toBe(PROMOTION_COMMENT);
  });

  it("leaves an existing delegate alone", async () => {
    const c = client();
    await run([issue({ delegate: { id: "other" } })], c);
    expect(c.log.map((e) => e.type)).toEqual(["moveToState", "addComment"]);
  });

  it("gives no delegate to unpromotable or non-mac issues", async () => {
    const c = client();
    await run(
      [
        issue({ id: "a", identifier: "A", labels: ["execution:mac", "human-only"] }),
        issue({ id: "b", identifier: "B", description: "" }),
        issue({ id: "c", identifier: "C", labels: ["execution:cloud"], project: "Hybrid Linear cloud + Mac workflow" }),
        issue({ id: "d", identifier: "D", blockedByIds: ["x"] }),
      ],
      c,
      { isBlockerSatisfied: () => false },
    );
    expect(c.log.filter((e) => e.type === "delegateIssue")).toEqual([]);
  });

  it("holds the issue out of Ready on a failed write, with no comment, and retries next pass", async () => {
    const c = client();
    let fail = true;
    const orig = c.delegateIssue;
    c.delegateIssue = async (...a) => {
      if (fail) return { success: true, delegateId: null };
      return orig(...a);
    };
    const first = await run([issue()], c);
    expect(first[0]).toMatchObject({ promoted: false, reason: expect.stringMatching(/^delegate assignment: .*readback/) });
    expect(c.log).toEqual([]);
    fail = false;
    const second = await run([issue()], c);
    expect(second[0].promoted).toBe(true);
    expect(c.log.map((e) => e.type)).toEqual(["delegateIssue", "moveToState", "addComment"]);
  });

  it("dry-run reports the planned delegate without writing", async () => {
    const c = client();
    const results = await run([issue()], c, { dryRun: true });
    expect(results[0]).toMatchObject({ promoted: true, delegatePlanned: true, delegateAssigned: false });
    expect(c.log).toEqual([]);
  });
});
