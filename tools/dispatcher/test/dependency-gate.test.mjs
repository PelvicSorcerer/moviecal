import { describe, it, expect } from "vitest";
import { buildIsIssueSatisfied } from "../src/dependency-gate.mjs";

function issueWithBlocker(blockerId, blockerStateName) {
  return {
    id: "id-self",
    inverseRelations: [{ type: "blocks", relatedIssue: { id: blockerId, state: { name: blockerStateName } } }],
  };
}

describe("buildIsIssueSatisfied", () => {
  it("treats a blocker in a completed/canceled state as satisfied", () => {
    for (const stateName of ["Done", "Released", "Canceled", "Duplicate"]) {
      const isIssueSatisfied = buildIsIssueSatisfied([issueWithBlocker("id-125", stateName)]);
      expect(isIssueSatisfied("id-125")).toBe(true);
    }
  });

  it("treats a blocker in an in-progress or backlog state as unsatisfied", () => {
    for (const stateName of ["In Review", "Backlog", "Agent Working", "Ready for Agent"]) {
      const isIssueSatisfied = buildIsIssueSatisfied([issueWithBlocker("id-125", stateName)]);
      expect(isIssueSatisfied("id-125")).toBe(false);
    }
  });

  it("fails closed for an id with no known blocker state", () => {
    const isIssueSatisfied = buildIsIssueSatisfied([issueWithBlocker("id-125", "Done")]);
    expect(isIssueSatisfied("id-999-unknown")).toBe(false);
  });

  it("ignores non-blocks relation types and relations without a relatedIssue", () => {
    const issue = {
      id: "id-self",
      inverseRelations: [
        { type: "related", relatedIssue: { id: "id-9", state: { name: "Done" } } },
        { type: "blocks", relatedIssue: null },
      ],
    };
    const isIssueSatisfied = buildIsIssueSatisfied([issue]);
    expect(isIssueSatisfied("id-9")).toBe(false);
  });

  it("merges blocker state across multiple issues in the batch", () => {
    const isIssueSatisfied = buildIsIssueSatisfied([issueWithBlocker("id-125", "Done"), issueWithBlocker("id-130", "In Review")]);
    expect(isIssueSatisfied("id-125")).toBe(true);
    expect(isIssueSatisfied("id-130")).toBe(false);
  });
});
