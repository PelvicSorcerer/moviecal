// Linear reconciliation for worktrees abandoned during dispatcher startup.

function recoveryComment(change) {
  if (!change.dirty) return `**Worktree abandoned:** ${change.reason}. Requeuing.`;
  const details = change.uncommittedPaths.length > 0
    ? `uncommitted changes (${change.uncommittedPaths.join(", ")})`
    : "commits not present on its remote-tracking branch";
  return `**Worktree abandoned:** ${change.reason}. Worktree at \`${change.path}\` has ${details}; it was preserved for inspection. Moving to Needs Human Decision.`;
}

/** Reconcile newly discovered or partially reported startup abandonments. */
export async function reconcileStartupRecoveries(changes, {
  worktreeManager,
  linearClient,
  readyForAgentStateId,
  needsHumanDecisionStateId,
  logger = console,
} = {}) {
  for (const change of changes) {
    if (!change.id || !change.linearIssueId) {
      logger.warn(`${change.id ?? change.path}: startup recovery has no Linear issue id; local record remains pending for manual reconciliation`);
      continue;
    }
    if (!linearClient) {
      logger.warn(`${change.id}: startup recovery needs Linear reconciliation but no client is configured; will retry`);
      continue;
    }
    const targetStateId = change.dirty ? needsHumanDecisionStateId : readyForAgentStateId;
    if (!targetStateId) {
      logger.warn(`${change.id}: startup recovery could not resolve its target Linear workflow state; will retry`);
      continue;
    }
    const progress = worktreeManager.loadState()[change.id]?.startupRecovery;
    if (!progress) continue;
    if (!progress.stateMoved) {
      await linearClient.moveToState(change.linearIssueId, targetStateId);
      worktreeManager.markStartupRecoveryProgress(change.id, { stateMoved: true });
    }
    if (!progress.commentPosted) {
      await linearClient.addComment(change.linearIssueId, recoveryComment(change));
      worktreeManager.markStartupRecoveryProgress(change.id, { commentPosted: true });
    }
  }
}
