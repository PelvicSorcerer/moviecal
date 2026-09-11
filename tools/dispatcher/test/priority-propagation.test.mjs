import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { computeEffectivePriorities, propagatePriorities, rank } from "../src/priority-propagation.mjs";

function issue(overrides = {}) {
  return {
    id: overrides.id || "id-1",
    identifier: overrides.identifier || "MOV-1",
    stateName: overrides.stateName || "Backlog",
    stateType: overrides.stateType || "unstarted",
    priority: overrides.priority ?? 0,
    relations: overrides.relations || [],
    ...overrides,
  };
}

function blocks(id) {
  return { type: "blocks", relatedIssue: { id } };
}

describe("rank", () => {
  it("orders 1 < 2 < 3 < 4 < 0 via Infinity mapping", () => {
    expect(rank(1)).toBeLessThan(rank(2));
    expect(rank(2)).toBeLessThan(rank(3));
    expect(rank(3)).toBeLessThan(rank(4));
    expect(rank(4)).toBeLessThan(rank(0));
  });
});

describe("computeEffectivePriorities", () => {
  it("raises a single blocker from downstream urgency", () => {
    const a = issue({ id: "a", identifier: "MOV-A", priority: 3, relations: [blocks("b")] });
    const b = issue({ id: "b", identifier: "MOV-B", priority: 1 });
    const priorities = computeEffectivePriorities([a, b]);
    expect(priorities.get("a")).toBe(1);
    expect(priorities.get("b")).toBe(1);
  });

  it("propagates through multi-step chains and keeps independent chains isolated", () => {
    const a = issue({ id: "a", identifier: "MOV-A", priority: 4, relations: [blocks("b")] });
    const b = issue({ id: "b", identifier: "MOV-B", priority: 3, relations: [blocks("c")] });
    const c = issue({ id: "c", identifier: "MOV-C", priority: 1 });
    const x = issue({ id: "x", identifier: "MOV-X", priority: 3, relations: [blocks("y")] });
    const y = issue({ id: "y", identifier: "MOV-Y", priority: 2 });
    const priorities = computeEffectivePriorities([a, b, c, x, y]);
    expect(priorities.get("a")).toBe(1);
    expect(priorities.get("b")).toBe(1);
    expect(priorities.get("x")).toBe(2);
  });

  it("ignores terminal downstream issues", () => {
    const a = issue({ id: "a", identifier: "MOV-A", priority: 3, relations: [blocks("d")] });
    const done = issue({ id: "d", identifier: "MOV-D", stateName: "Done", stateType: "completed", priority: 1 });
    const priorities = computeEffectivePriorities([a, done]);
    expect(priorities.get("a")).toBe(3);
  });

  it("handles long dependency chains without stack overflow", () => {
    const depth = 12000;
    const issues = [];
    for (let i = 0; i < depth; i++) {
      issues.push(
        issue({
          id: `id-${i}`,
          identifier: `MOV-${i}`,
          priority: i === depth - 1 ? 1 : 4,
          relations: i < depth - 1 ? [blocks(`id-${i + 1}`)] : [],
        }),
      );
    }
    const priorities = computeEffectivePriorities(issues);
    expect(priorities.get("id-0")).toBe(1);
    expect(priorities.get(`id-${depth - 1}`)).toBe(1);
  });
});

describe("propagatePriorities", () => {
  function tempStatePath() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "priority-propagation-")), "priority-propagation.json");
  }

  function fakeLogger() {
    return { log: vi.fn(), warn: vi.fn() };
  }

  it("is idempotent across two unchanged passes", async () => {
    const statePath = tempStatePath();
    const linearClient = { updateIssuePriority: vi.fn().mockResolvedValue(true) };
    const logger = fakeLogger();
    const issues = [
      issue({ id: "a", identifier: "MOV-A", priority: 3, relations: [blocks("b")] }),
      issue({ id: "b", identifier: "MOV-B", priority: 1 }),
    ];

    await propagatePriorities(issues, { linearClient, stateFilePath: statePath, logger });
    await propagatePriorities(
      [
        issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [blocks("b")] }),
        issue({ id: "b", identifier: "MOV-B", priority: 1 }),
      ],
      { linearClient, stateFilePath: statePath, logger },
    );

    expect(linearClient.updateIssuePriority).toHaveBeenCalledTimes(1);
    expect(linearClient.updateIssuePriority).toHaveBeenLastCalledWith("a", 1);
  });

  it("handles cycles once and propagates cycle max", async () => {
    const statePath = tempStatePath();
    const linearClient = { updateIssuePriority: vi.fn().mockResolvedValue(true) };
    const logger = fakeLogger();
    const issues = [
      issue({ id: "a", identifier: "MOV-A", priority: 3, relations: [blocks("b")] }),
      issue({ id: "b", identifier: "MOV-B", priority: 1, relations: [blocks("a")] }),
      issue({ id: "c", identifier: "MOV-C", priority: 4, relations: [blocks("a")] }),
    ];

    const result = await propagatePriorities(issues, { linearClient, stateFilePath: statePath, logger });

    expect(result.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identifier: "MOV-A", from: 3, to: 1, action: "raised" }),
        expect.objectContaining({ identifier: "MOV-C", from: 4, to: 1, action: "raised" }),
      ]),
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/cycle/i);
  });

  it("skips Icebox/Triage writes but logs would-raise with driver", async () => {
    const statePath = tempStatePath();
    const linearClient = { updateIssuePriority: vi.fn().mockResolvedValue(true) };
    const logger = fakeLogger();
    const issues = [
      issue({ id: "a", identifier: "MOV-A", stateName: "Icebox", priority: 4, relations: [blocks("b")] }),
      issue({ id: "b", identifier: "MOV-B", priority: 1 }),
      issue({ id: "c", identifier: "MOV-C", stateName: "Backlog", priority: 4, relations: [blocks("b")] }),
    ];

    const result = await propagatePriorities(issues, { linearClient, stateFilePath: statePath, logger });

    expect(linearClient.updateIssuePriority).toHaveBeenCalledTimes(1);
    expect(linearClient.updateIssuePriority).toHaveBeenCalledWith("c", 1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ identifier: "MOV-A", to: 1, driverIdentifier: "MOV-B" });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("MOV-A (Icebox) blocks Urgent MOV-B"));
  });

  it("never updates terminal issues and prunes terminal/non-writable entries from state file", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        terminal: { lastPropagated: 1, manualFloor: 1 },
        triage: { lastPropagated: 2, manualFloor: 2 },
        keep: { lastPropagated: 1, manualFloor: 1 },
      }) + "\n",
      "utf8",
    );
    const linearClient = { updateIssuePriority: vi.fn().mockResolvedValue(true) };

    await propagatePriorities(
      [
        issue({ id: "terminal", identifier: "MOV-T", stateName: "Done", stateType: "completed", priority: 4 }),
        issue({ id: "triage", identifier: "MOV-R", stateName: "Triage", stateType: "triage", priority: 4 }),
        issue({ id: "keep", identifier: "MOV-K", stateName: "Backlog", stateType: "unstarted", priority: 1 }),
      ],
      { linearClient, stateFilePath: statePath, logger: fakeLogger() },
    );

    expect(linearClient.updateIssuePriority).not.toHaveBeenCalledWith("terminal", expect.anything());
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(stored).toEqual({ keep: { lastPropagated: 1, manualFloor: 1 } });
  });

  it("leaves manual priority changes untouched when current !== recorded", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 1, manualFloor: 3 } }) + "\n", "utf8");
    const linearClient = { updateIssuePriority: vi.fn().mockResolvedValue(true) };
    const logger = fakeLogger();

    await propagatePriorities(
      [issue({ id: "a", identifier: "MOV-A", priority: 2, relations: [] })],
      { linearClient, stateFilePath: statePath, logger },
    );
    expect(linearClient.updateIssuePriority).not.toHaveBeenCalled();
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(stored).toEqual({ a: { lastPropagated: 2, manualFloor: 2 } });
  });

  it("relaxes an owned propagated raise when downstream driver goes away", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 1, manualFloor: 3 } }) + "\n", "utf8");
    const linearClient = { updateIssuePriority: vi.fn().mockResolvedValue(true) };

    await propagatePriorities(
      [issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [] })],
      { linearClient, stateFilePath: statePath, logger: fakeLogger() },
    );

    expect(linearClient.updateIssuePriority).toHaveBeenCalledWith("a", 3);
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(stored).toEqual({ a: { lastPropagated: 3, manualFloor: 3 } });
  });

  it("does not record ownership updates when Linear priority mutation fails", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 1, manualFloor: 3 } }) + "\n", "utf8");
    const linearClient = { updateIssuePriority: vi.fn().mockResolvedValue(false) };
    const logger = fakeLogger();

    await propagatePriorities(
      [issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [] })],
      { linearClient, stateFilePath: statePath, logger },
    );

    expect(linearClient.updateIssuePriority).toHaveBeenCalledWith("a", 3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to apply priority update"));
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(stored).toEqual({ a: { lastPropagated: 1, manualFloor: 3 } });
  });

  it("continues after a thrown update failure and reports only successful writes", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        a: { lastPropagated: 1, manualFloor: 3 },
        c: { lastPropagated: 4, manualFloor: 4 },
      }) + "\n",
      "utf8",
    );
    const linearClient = {
      updateIssuePriority: vi.fn().mockImplementation(async (issueId) => {
        if (issueId === "a") throw new Error("network down");
        return true;
      }),
    };
    const logger = fakeLogger();
    const result = await propagatePriorities(
      [
        issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [] }),
        issue({ id: "c", identifier: "MOV-C", priority: 4, relations: [blocks("d")] }),
        issue({ id: "d", identifier: "MOV-D", priority: 2 }),
      ],
      { linearClient, stateFilePath: statePath, logger },
    );

    expect(linearClient.updateIssuePriority).toHaveBeenCalledTimes(2);
    expect(result.wrote).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(stored).toEqual({
      a: { lastPropagated: 1, manualFloor: 3 },
      c: { lastPropagated: 2, manualFloor: 4 },
      d: { lastPropagated: 2, manualFloor: 2 },
    });
  });

  it("skips dependent relaxations when the downstream driver update fails", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        a: { lastPropagated: 1, manualFloor: 3 },
        b: { lastPropagated: 1, manualFloor: 3 },
      }) + "\n",
      "utf8",
    );
    const linearClient = {
      updateIssuePriority: vi.fn().mockImplementation(async (issueId) => {
        if (issueId === "b") throw new Error("linear timeout");
        return true;
      }),
    };
    const logger = fakeLogger();

    const result = await propagatePriorities(
      [
        issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [blocks("b")] }),
        issue({ id: "b", identifier: "MOV-B", priority: 1, relations: [] }),
      ],
      { linearClient, stateFilePath: statePath, logger },
    );

    expect(result.wrote).toBe(0);
    expect(linearClient.updateIssuePriority).toHaveBeenCalledTimes(1);
    expect(linearClient.updateIssuePriority).toHaveBeenCalledWith("b", 3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("driver MOV-B failed to update"));
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(stored).toEqual({
      a: { lastPropagated: 1, manualFloor: 3 },
      b: { lastPropagated: 1, manualFloor: 3 },
    });
  });

  it("does not relax an ancestor when any downstream owned relaxation fails", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        a: { lastPropagated: 1, manualFloor: 4 },
        b: { lastPropagated: 1, manualFloor: 4 },
      }) + "\n",
      "utf8",
    );
    const linearClient = {
      updateIssuePriority: vi.fn().mockImplementation(async (issueId) => {
        if (issueId === "b") throw new Error("linear timeout");
        return true;
      }),
    };
    const logger = fakeLogger();

    await propagatePriorities(
      [
        issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [blocks("b"), blocks("c")] }),
        issue({ id: "b", identifier: "MOV-B", priority: 1 }),
        issue({ id: "c", identifier: "MOV-C", priority: 2 }),
      ],
      { linearClient, stateFilePath: statePath, logger },
    );

    // C is the selected graph driver for A (priority 2), but B remains
    // urgent when its own relaxation fails. A must not be relaxed to 2.
    expect(linearClient.updateIssuePriority).toHaveBeenCalledTimes(1);
    expect(linearClient.updateIssuePriority).toHaveBeenCalledWith("b", 4);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("downstream relaxation failed"));
  });

  it("recovers ownership when final state persistence fails after a successful Linear mutation", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 1, manualFloor: 3 } }) + "\n", "utf8");
    const originalRename = fs.renameSync;
    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("disk full");
      return originalRename(...args);
    });

    try {
      await propagatePriorities(
        [issue({ id: "a", identifier: "MOV-A", priority: 1 })],
        { linearClient: { updateIssuePriority: vi.fn().mockResolvedValue(true) }, stateFilePath: statePath, logger: fakeLogger() },
      );
    } finally {
      renameSpy.mockRestore();
    }

    // The durable intent from before the mutation lets the next pass recognize
    // the live value as propagated rather than incorrectly treating it as manual.
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
      a: { lastPropagated: 1, manualFloor: 3, pending: 3 },
    });
    await propagatePriorities(
      [issue({ id: "a", identifier: "MOV-A", priority: 3 })],
      { linearClient: { updateIssuePriority: vi.fn().mockResolvedValue(true) }, stateFilePath: statePath, logger: fakeLogger() },
    );
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({ a: { lastPropagated: 3, manualFloor: 3 } });
  });

  it("dry-run reports intended changes without writes or state-file rewrites", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 3, manualFloor: 3 } }) + "\n", "utf8");
    const initial = fs.readFileSync(statePath, "utf8");
    const linearClient = { updateIssuePriority: vi.fn().mockResolvedValue(true) };

    const result = await propagatePriorities(
      [
        issue({ id: "a", identifier: "MOV-A", priority: 3, relations: [blocks("b")] }),
        issue({ id: "b", identifier: "MOV-B", priority: 1 }),
      ],
      { linearClient, stateFilePath: statePath, logger: fakeLogger(), dryRun: true },
    );

    expect(result.updates).toEqual([expect.objectContaining({ identifier: "MOV-A", from: 3, to: 1, action: "raised" })]);
    expect(linearClient.updateIssuePriority).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, "utf8")).toBe(initial);
  });

  it("tightens insecure state directory/file permissions on non-dry runs", async () => {
    const statePath = tempStatePath();
    const dirPath = path.dirname(statePath);
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 1, manualFloor: 1 } }) + "\n", "utf8");
    fs.chmodSync(dirPath, 0o755);
    fs.chmodSync(statePath, 0o644);

    await propagatePriorities(
      [issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [] })],
      { linearClient: { updateIssuePriority: vi.fn().mockResolvedValue(true) }, stateFilePath: statePath, logger: fakeLogger() },
    );

    expect(fs.statSync(dirPath).mode & 0o077).toBe(0);
    expect(fs.statSync(statePath).mode & 0o077).toBe(0);
  });

  it("tightens insecure state directory permissions even when state file does not exist", async () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), "priority-propagation-"));
    fs.chmodSync(dirPath, 0o755);
    const statePath = path.join(dirPath, "priority-propagation.json");

    await propagatePriorities(
      [issue({ id: "done", identifier: "MOV-DONE", stateName: "Done", stateType: "completed", priority: 0 })],
      { linearClient: { updateIssuePriority: vi.fn().mockResolvedValue(true) }, stateFilePath: statePath, logger: fakeLogger() },
    );

    expect(fs.statSync(dirPath).mode & 0o077).toBe(0);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("fails when insecure state-file permissions cannot be repaired", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 1, manualFloor: 1 } }) + "\n", "utf8");
    fs.chmodSync(statePath, 0o644);
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("permission denied");
    });

    try {
      await expect(
        propagatePriorities(
          [issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [] })],
          { linearClient: { updateIssuePriority: vi.fn().mockResolvedValue(true) }, stateFilePath: statePath, logger: fakeLogger() },
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      chmodSpy.mockRestore();
    }
  });

  it("dry-run does not mutate insecure state-file permissions", async () => {
    const statePath = tempStatePath();
    const dirPath = path.dirname(statePath);
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 1, manualFloor: 1 } }) + "\n", "utf8");
    fs.chmodSync(dirPath, 0o755);
    fs.chmodSync(statePath, 0o644);

    await propagatePriorities(
      [issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [] })],
      { linearClient: { updateIssuePriority: vi.fn().mockResolvedValue(true) }, stateFilePath: statePath, logger: fakeLogger(), dryRun: true },
    );

    expect(fs.statSync(dirPath).mode & 0o077).toBe(0o55);
    expect(fs.statSync(statePath).mode & 0o077).toBe(0o44);
  });

  it("does not rewrite the state file when state is unchanged", async () => {
    const statePath = tempStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ a: { lastPropagated: 1, manualFloor: 1 } }) + "\n", "utf8");
    const before = fs.statSync(statePath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await propagatePriorities(
      [issue({ id: "a", identifier: "MOV-A", priority: 1, relations: [] })],
      { linearClient: { updateIssuePriority: vi.fn().mockResolvedValue(true) }, stateFilePath: statePath, logger: fakeLogger() },
    );

    const after = fs.statSync(statePath).mtimeMs;
    expect(after).toBe(before);
  });
});
