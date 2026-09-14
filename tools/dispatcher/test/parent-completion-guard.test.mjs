import { describe, it, expect } from "vitest";
import {
  assertParentCompletable,
  reconcileParentCompletion,
  COMPLETING_CHILD_STATE_NAMES,
  PARENT_REOPEN_STATE_NAME,
} from "../src/parent-completion-guard.mjs";

function child(identifier, stateName) {
  return { id: `id-${identifier}`, identifier, stateName };
}

function parent(identifier, stateName, children) {
  return { id: `id-${identifier}`, identifier, stateName, children };
}

function fakeLinearClient() {
  const calls = [];
  return {
    calls,
    moveToState: async (issueId, stateId) => {
      calls.push({ type: "moveToState", issueId, stateId });
    },
    addComment: async (issueId, body) => {
      calls.push({ type: "addComment", issueId, body });
    },
  };
}

describe("COMPLETING_CHILD_STATE_NAMES / PARENT_REOPEN_STATE_NAME", () => {
  it("only Done/Released drive completion, and reopening targets In Review", () => {
    expect(COMPLETING_CHILD_STATE_NAMES.has("Done")).toBe(true);
    expect(COMPLETING_CHILD_STATE_NAMES.has("Released")).toBe(true);
    expect(COMPLETING_CHILD_STATE_NAMES.has("Canceled")).toBe(false);
    expect(COMPLETING_CHILD_STATE_NAMES.has("Duplicate")).toBe(false);
    expect(PARENT_REOPEN_STATE_NAME).toBe("In Review");
  });
});

describe("assertParentCompletable", () => {
  it("does not throw when every child is terminal", () => {
    expect(() =>
      assertParentCompletable(parent("MOV-1", "In Review", null), [
        child("MOV-2", "Done"),
        child("MOV-3", "Canceled"),
      ]),
    ).not.toThrow();
  });

  it("does not throw for a parent with no children", () => {
    expect(() => assertParentCompletable(parent("MOV-1", "In Review", null), [])).not.toThrow();
    expect(() => assertParentCompletable(parent("MOV-1", "In Review", null))).not.toThrow();
  });

  it("rejects a direct completion attempt with a non-terminal child, naming it", () => {
    expect(() =>
      assertParentCompletable({ identifier: "MOV-1" }, [
        child("MOV-2", "Done"),
        child("MOV-3", "Agent Working"),
      ]),
    ).toThrow(/MOV-1.*MOV-3/s);
  });

  it("names every non-terminal child when more than one is open", () => {
    expect(() =>
      assertParentCompletable({ identifier: "MOV-1" }, [
        child("MOV-2", "In Review"),
        child("MOV-3", "Agent Working"),
      ]),
    ).toThrow(/MOV-2.*MOV-3/s);
  });
});

describe("reconcileParentCompletion", () => {
  it("completes a parent once every child is Done, with a comment listing both children", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "In Review", [child("MOV-373", "Done"), child("MOV-374", "Done")])];

    const results = await reconcileParentCompletion(parents, {
      linearClient,
      doneStateId: "state-done",
      reopenStateId: "state-in-review",
    });

    expect(results).toEqual([
      { id: "id-MOV-366", identifier: "MOV-366", action: "completed", dryRun: false, children: ["MOV-373", "MOV-374"] },
    ]);
    expect(linearClient.calls).toEqual([
      { type: "moveToState", issueId: "id-MOV-366", stateId: "state-done" },
      { type: "addComment", issueId: "id-MOV-366", body: expect.stringContaining("MOV-373") },
    ]);
    expect(linearClient.calls[1].body).toContain("MOV-374");
  });

  it("does nothing for a mix of complete and incomplete children, and stays a no-op on re-run", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "In Review", [child("MOV-373", "Done"), child("MOV-374", "Agent Working")])];
    const ctx = { linearClient, doneStateId: "state-done", reopenStateId: "state-in-review" };

    const first = await reconcileParentCompletion(parents, ctx);
    expect(first).toEqual([]);
    expect(linearClient.calls).toEqual([]);

    const second = await reconcileParentCompletion(parents, ctx);
    expect(second).toEqual([]);
    expect(linearClient.calls).toEqual([]);
  });

  it("reopens a parent marked Done while a child is still non-terminal, naming the child", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "Done", [child("MOV-373", "Done"), child("MOV-374", "Agent Working")])];

    const results = await reconcileParentCompletion(parents, {
      linearClient,
      doneStateId: "state-done",
      reopenStateId: "state-in-review",
    });

    expect(results).toEqual([
      { id: "id-MOV-366", identifier: "MOV-366", action: "reopened", dryRun: false, offendingChildren: ["MOV-374"] },
    ]);
    expect(linearClient.calls).toEqual([
      { type: "moveToState", issueId: "id-MOV-366", stateId: "state-in-review" },
      { type: "addComment", issueId: "id-MOV-366", body: expect.stringContaining("MOV-374") },
    ]);
  });

  it("reopens a parent marked Released the same way", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "Released", [child("MOV-374", "In Review")])];

    const results = await reconcileParentCompletion(parents, {
      linearClient,
      doneStateId: "state-done",
      reopenStateId: "state-in-review",
    });

    expect(results[0]).toMatchObject({ action: "reopened", offendingChildren: ["MOV-374"] });
  });

  it("completes a parent when one child is Canceled and the other Done (Canceled does not block)", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "In Review", [child("MOV-373", "Canceled"), child("MOV-374", "Done")])];

    const results = await reconcileParentCompletion(parents, {
      linearClient,
      doneStateId: "state-done",
      reopenStateId: "state-in-review",
    });

    expect(results).toEqual([
      { id: "id-MOV-366", identifier: "MOV-366", action: "completed", dryRun: false, children: ["MOV-373", "MOV-374"] },
    ]);
    expect(linearClient.calls[0]).toEqual({ type: "moveToState", issueId: "id-MOV-366", stateId: "state-done" });
  });

  it("does not auto-complete a parent whose children are only Canceled/Duplicate", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "In Review", [child("MOV-373", "Canceled"), child("MOV-374", "Duplicate")])];

    const results = await reconcileParentCompletion(parents, {
      linearClient,
      doneStateId: "state-done",
      reopenStateId: "state-in-review",
    });

    expect(results).toEqual([]);
    expect(linearClient.calls).toEqual([]);
  });

  it("skips a parent with no children entirely (no sub-issues means no inference)", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "Done", [])];

    const results = await reconcileParentCompletion(parents, {
      linearClient,
      doneStateId: "state-done",
      reopenStateId: "state-in-review",
    });

    expect(results).toEqual([]);
    expect(linearClient.calls).toEqual([]);
  });

  it("--dry-run reports every intended action (complete and reopen) and writes nothing", async () => {
    const linearClient = fakeLinearClient();
    const parents = [
      parent("MOV-366", "In Review", [child("MOV-373", "Done"), child("MOV-374", "Released")]),
      parent("MOV-400", "Done", [child("MOV-401", "In Review")]),
    ];

    const results = await reconcileParentCompletion(parents, {
      linearClient,
      doneStateId: "state-done",
      reopenStateId: "state-in-review",
      dryRun: true,
    });

    expect(results).toEqual([
      { id: "id-MOV-366", identifier: "MOV-366", action: "completed", dryRun: true, children: ["MOV-373", "MOV-374"] },
      { id: "id-MOV-400", identifier: "MOV-400", action: "reopened", dryRun: true, offendingChildren: ["MOV-401"] },
    ]);
    expect(linearClient.calls).toEqual([]);
  });

  it("logs and records an error, without throwing, when doneStateId is missing", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "In Review", [child("MOV-373", "Done")])];
    const warnings = [];

    const results = await reconcileParentCompletion(parents, {
      linearClient,
      reopenStateId: "state-in-review",
      logger: { warn: (msg) => warnings.push(msg) },
    });

    expect(results).toEqual([{ id: "id-MOV-366", identifier: "MOV-366", action: "error", error: expect.stringContaining("doneStateId") }]);
    expect(linearClient.calls).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MOV-366");
  });

  it("logs and records an error, without throwing, when reopenStateId is missing", async () => {
    const linearClient = fakeLinearClient();
    const parents = [parent("MOV-366", "Done", [child("MOV-373", "In Review")])];

    const results = await reconcileParentCompletion(parents, { linearClient, doneStateId: "state-done" });

    expect(results).toEqual([{ id: "id-MOV-366", identifier: "MOV-366", action: "error", error: expect.stringContaining("reopenStateId") }]);
    expect(linearClient.calls).toEqual([]);
  });

  it("processes every parent even when one fails", async () => {
    const linearClient = fakeLinearClient();
    const parents = [
      parent("MOV-1", "In Review", [child("MOV-1a", "Done")]),
      parent("MOV-2", "In Review", [child("MOV-2a", "Done")]),
    ];

    const results = await reconcileParentCompletion(parents, { linearClient, reopenStateId: "state-in-review" });

    expect(results.map((r) => r.action)).toEqual(["error", "error"]);
    expect(results.map((r) => r.identifier)).toEqual(["MOV-1", "MOV-2"]);
  });
});
