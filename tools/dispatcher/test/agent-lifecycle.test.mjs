import { describe, it, expect, vi } from "vitest";
import { LifecyclePublisher } from "../src/agent-lifecycle.mjs";
import { AgentSessionBridge } from "../src/agent-session.mjs";

const ISSUE = { id: "uuid-1", identifier: "MOV-158", url: "https://linear.app/moviecal/issue/MOV-158" };

function fakeLinearClient() {
  return {
    calls: [],
    addComment: vi.fn(async function (issueId, body) {
      this.calls.push({ type: "addComment", issueId, body });
    }),
    moveToState: vi.fn(async function (issueId, stateId) {
      this.calls.push({ type: "moveToState", issueId, stateId });
    }),
  };
}

/** A Linear client that also speaks the Agent Session surface, so sessions can be exercised. */
function fakeSessionLinearClient() {
  const client = fakeLinearClient();
  client.activities = [];
  client.createAgentSessionOnIssue = vi.fn(async () => ({ id: "session-1" }));
  client.createAgentActivity = vi.fn(async function ({ agentSessionId, content }) {
    this.activities.push({ agentSessionId, content });
    return true;
  });
  client.updateAgentSessionExternalLink = vi.fn(async () => true);
  return client;
}

function publisherWith(linearClient, { enabled = false } = {}) {
  return new LifecyclePublisher({
    linearClient,
    bridge: new AgentSessionBridge({ linearClient, enabled }),
    context: { issue: ISSUE, branch: "agent/MOV-158-thing", worker: "claude", model: "strong" },
  });
}

describe("LifecyclePublisher", () => {
  it("requires a Linear client — the comment surface is never optional", () => {
    expect(() => new LifecyclePublisher({})).toThrow(/requires a linearClient/);
  });

  it("publishes an app-actor comment when sessions are unavailable (today's every run)", async () => {
    const linearClient = fakeLinearClient();
    const publisher = publisherWith(linearClient);
    await publisher.begin();

    const result = await publisher.publish("acknowledged", {
      summary: "Dispatcher picked up MOV-158.",
      headline: "**Dispatcher started work.**",
      sections: ["Branch: `agent/MOV-158-thing`"],
    });

    expect(result.surface).toBe("comment");
    expect(linearClient.calls).toEqual([
      {
        type: "addComment",
        issueId: "uuid-1",
        body: "**Dispatcher started work.**\n\nBranch: `agent/MOV-158-thing`",
      },
    ]);
  });

  it("publishes an Agent Activity instead of a comment when a session exists", async () => {
    const linearClient = fakeSessionLinearClient();
    const publisher = publisherWith(linearClient, { enabled: true });
    await publisher.begin();

    const result = await publisher.publish("acknowledged", { summary: "Dispatcher picked up MOV-158." });

    expect(result.surface).toBe("agent-activity");
    expect(linearClient.activities).toHaveLength(1);
    expect(linearClient.addComment).not.toHaveBeenCalled();
  });

  it("writes the workflow-state transition whichever surface wins — state is control data, not presentation", async () => {
    for (const enabled of [false, true]) {
      const linearClient = fakeSessionLinearClient();
      const publisher = publisherWith(linearClient, { enabled });
      await publisher.begin();

      await publisher.publish("pr-opened", { summary: "PR opened", stateId: "state-in-review", prUrl: "https://gh/pr/1" });

      expect(linearClient.moveToState, `enabled=${enabled}`).toHaveBeenCalledWith("uuid-1", "state-in-review");
    }
  });

  it("moves state before publishing, so a reader never sees the comment ahead of the state", async () => {
    const linearClient = fakeLinearClient();
    const publisher = publisherWith(linearClient);
    await publisher.begin();

    await publisher.publish("error", { summary: "Worker exited with code 1.", stateId: "state-needs-human" });

    expect(linearClient.calls.map((c) => c.type)).toEqual(["moveToState", "addComment"]);
  });

  it("falls back to a comment when the activity mutation fails, so nothing is lost", async () => {
    const linearClient = fakeSessionLinearClient();
    linearClient.createAgentActivity = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const publisher = publisherWith(linearClient, { enabled: true });
    await publisher.begin();

    const result = await publisher.publish("error", { summary: "Worker exited with code 1." });

    expect(result.surface).toBe("comment");
    expect(linearClient.addComment).toHaveBeenCalledTimes(1);
  });

  it("falls back to a comment when the session could not be created at all (MOV-141)", async () => {
    const linearClient = fakeSessionLinearClient();
    linearClient.createAgentSessionOnIssue = vi.fn(async () => {
      throw new Error("Linear API error: agent sessions disabled");
    });
    const publisher = publisherWith(linearClient, { enabled: true });

    const begun = await publisher.begin();
    const result = await publisher.publish("acknowledged", { summary: "Dispatcher picked up MOV-158." });

    expect(begun.mode).toBe("unavailable");
    expect(result.surface).toBe("comment");
    expect(linearClient.addComment).toHaveBeenCalledTimes(1);
  });

  it("publishes the same transition once, however many times it is asked to", async () => {
    const linearClient = fakeLinearClient();
    const publisher = publisherWith(linearClient);
    await publisher.begin();

    const fields = { summary: "PR opened", stateId: "state-in-review", prUrl: "https://gh/pr/1" };
    const first = await publisher.publish("pr-opened", fields);
    const second = await publisher.publish("pr-opened", fields);

    expect(first.surface).toBe("comment");
    expect(second).toMatchObject({ surface: "none", reason: "already published" });
    expect(linearClient.addComment).toHaveBeenCalledTimes(1);
    // Critically, the duplicate must not re-fire the state transition either.
    expect(linearClient.moveToState).toHaveBeenCalledTimes(1);
  });

  it("still publishes a genuinely different event of the same kind", async () => {
    const linearClient = fakeLinearClient();
    const publisher = publisherWith(linearClient);
    await publisher.begin();

    await publisher.publish("progress", { summary: "ran verify", action: "verify" });
    await publisher.publish("progress", { summary: "ran the browser lane", action: "verify" });

    expect(linearClient.addComment).toHaveBeenCalledTimes(2);
  });

  it("drops a malformed event without failing the attempt", async () => {
    const linearClient = fakeLinearClient();
    const logger = { error: vi.fn() };
    const publisher = new LifecyclePublisher({ linearClient, logger, context: { issue: ISSUE } });

    const result = await publisher.publish("nonsense", { summary: "?" });

    expect(result.surface).toBe("none");
    expect(logger.error).toHaveBeenCalled();
    expect(linearClient.addComment).not.toHaveBeenCalled();
  });

  it("carries newly-learned identity into later events", async () => {
    const linearClient = fakeLinearClient();
    const publisher = publisherWith(linearClient);
    await publisher.begin();

    publisher.setContext({ prUrl: "https://gh/pr/1" });
    await publisher.publish("complete", { summary: "Attempt finished." });

    expect(publisher.context.prUrl).toBe("https://gh/pr/1");
  });

  it("resolves a new linked attempt number from the prior session record", async () => {
    const linearClient = fakeSessionLinearClient();
    const publisher = publisherWith(linearClient, { enabled: true });

    await publisher.begin({ existing: { id: "session-prior", status: "complete", attempt: 1 } });

    expect(publisher.context.attempt).toBe(2);
    expect(publisher.context.previousSessionId).toBe("session-prior");
  });

  it("exposes the session snapshot for persistence and can flush a queued activity", async () => {
    const linearClient = fakeSessionLinearClient();
    const publisher = publisherWith(linearClient, { enabled: true });
    await publisher.begin();

    expect(publisher.snapshot().id).toBe("session-1");
    expect(await publisher.flushPending()).toEqual({ flushed: 0, remaining: 0 });
  });

  it("moveState writes control state without publishing to either presentation surface", async () => {
    const linearClient = fakeLinearClient();
    const publisher = publisherWith(linearClient);

    await publisher.moveState("state-blocked");

    expect(linearClient.calls).toEqual([{ type: "moveToState", issueId: "uuid-1", stateId: "state-blocked" }]);
  });
});
