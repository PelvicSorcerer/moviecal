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
});
