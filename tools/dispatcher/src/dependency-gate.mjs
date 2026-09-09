// Resolves whether a Linear "blocks" relation is satisfied, using blocker
// workflow-state data already returned by LinearClient.issuesInState()'s
// inverseRelations query -- no extra Linear API call needed. See
// docs/operators/local-execution.md §Preflight gates and
// docs/governance/linear-information-architecture.md §Relations for the
// blockedByIds/inverseRelations direction this depends on (MOV-128).

const COMPLETED_BLOCKER_STATE_NAMES = new Set(["Done", "Released", "Canceled", "Duplicate"]);

/**
 * @param {object[]} issues - normalized issues from LinearClient.issuesInState(),
 *   each carrying `inverseRelations` (raw nodes: {type, relatedIssue: {id, state: {name}}})
 * @returns {(id: string) => boolean} true if the blocker issue `id` is in a
 *   completed/canceled workflow state. Fails closed (false) for an id with no
 *   known state -- an unresolved blocker should never be treated as satisfied.
 */
export function buildIsIssueSatisfied(issues) {
  const blockerStateNameById = new Map();
  for (const issue of issues) {
    for (const relation of issue.inverseRelations || []) {
      if (relation.type === "blocks" && relation.relatedIssue) {
        blockerStateNameById.set(relation.relatedIssue.id, relation.relatedIssue.state ? relation.relatedIssue.state.name : null);
      }
    }
  }
  return (id) => COMPLETED_BLOCKER_STATE_NAMES.has(blockerStateNameById.get(id));
}
