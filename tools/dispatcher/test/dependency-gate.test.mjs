import { describe, it, expect } from "vitest";
import { buildIsIssueSatisfied } from "../src/dependency-gate.mjs";

// Real Linear shape for a "blocks" entry under an issue's inverseRelations:
// `issue` is the blocker, `relatedIssue` is this issue (self). Verified live
// against MOV-125 → MOV-126 (MOV-128 follow-up).
function issueWithBlocker(blockerId, blockerStateName) {
  return {
    id: "id-self",
    inverseRelations: [
      {
        type: "blocks",
        issue: { id: blockerId, state: { name: blockerStateName } },
        relatedIssue: { id: "id-self" },
      },
    ],
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

  it("keys on the blocker (inverseRelations.issue), never on self (relatedIssue)", () => {
    // MOV-126 blocked by MOV-125 (Done). The gate must report MOV-125's id as
    // satisfied and must NOT register MOV-126's own id from `relatedIssue`.
    const issue = {
      id: "id-126",
      inverseRelations: [
        { type: "blocks", issue: { id: "id-125", state: { name: "Done" } }, relatedIssue: { id: "id-126" } },
      ],
    };
    const isIssueSatisfied = buildIsIssueSatisfied([issue]);
    expect(isIssueSatisfied("id-125")).toBe(true);
    expect(isIssueSatisfied("id-126")).toBe(false); // self is not a blocker
  });

  it("fails closed for an id with no known blocker state", () => {
    const isIssueSatisfied = buildIsIssueSatisfied([issueWithBlocker("id-125", "Done")]);
    expect(isIssueSatisfied("id-999-unknown")).toBe(false);
  });

  it("ignores non-blocks relation types and relations without an issue", () => {
    const issue = {
      id: "id-self",
      inverseRelations: [
        { type: "related", issue: { id: "id-9", state: { name: "Done" } }, relatedIssue: { id: "id-self" } },
        { type: "blocks", issue: null, relatedIssue: { id: "id-self" } },
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
