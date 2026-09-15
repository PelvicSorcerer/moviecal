import { describe, expect, it, vi } from "vitest";
import { assertParentCompletable, evaluateParentReconciliation, reconcileParents } from "../src/parent-completion-guard.mjs";

const parent = (stateName = "In Review") => ({ id: "parent", identifier: "MOV-1", stateName });
const child = (identifier, stateName) => ({ id: identifier, identifier, stateName });

describe("parent completion guard (MOV-172)", () => {
  it("refuses a direct completion with a non-terminal child", () => {
    expect(() => assertParentCompletable(parent(), [child("MOV-2", "Agent Working")])).toThrow(/MOV-2/);
    expect(() => assertParentCompletable(parent(), [child("MOV-2", "Canceled"), child("MOV-3", "Done")])).not.toThrow();
  });

  it("completes only after every child is terminal and at least one drives completion", () => {
    expect(evaluateParentReconciliation(parent(), [child("MOV-2", "Done"), child("MOV-3", "Done")])).toMatchObject({ action: "complete", comment: expect.stringMatching(/MOV-2[\s\S]*MOV-3/) });
    expect(evaluateParentReconciliation(parent(), [child("MOV-2", "Done"), child("MOV-3", "Agent Working")]).action).toBe("none");
    expect(evaluateParentReconciliation(parent(), [child("MOV-2", "Canceled"), child("MOV-3", "Done")]).action).toBe("complete");
    expect(evaluateParentReconciliation(parent(), [child("MOV-2", "Canceled"), child("MOV-3", "Duplicate")]).action).toBe("none");
  });

  it("flags a premature Done/Released parent and is idempotent for unchanged input", () => {
    const input = [child("MOV-2", "Done"), child("MOV-3", "Agent Working")];
    const first = evaluateParentReconciliation(parent("Done"), input);
    expect(first).toMatchObject({ action: "reopen", comment: expect.stringContaining("MOV-3") });
    expect(evaluateParentReconciliation(parent("Done"), input)).toEqual(first);
    expect(evaluateParentReconciliation(parent("Released"), input).action).toBe("reopen");
  });

  it("reports all changes in dry-run without writing", async () => {
    const linearClient = { moveToState: vi.fn(), addComment: vi.fn() };
    const result = await reconcileParents([
      { ...parent(), children: [child("MOV-2", "Done")] },
      { ...parent("Done"), id: "parent-2", identifier: "MOV-4", children: [child("MOV-5", "Agent Working")] },
    ], { linearClient, doneStateId: "done", needsHumanDecisionStateId: "human", dryRun: true });
    expect(result.map(({ issue, action }) => [issue, action])).toEqual([["MOV-1", "complete"], ["MOV-4", "reopen"]]);
    expect(linearClient.moveToState).not.toHaveBeenCalled();
    expect(linearClient.addComment).not.toHaveBeenCalled();
  });
});
