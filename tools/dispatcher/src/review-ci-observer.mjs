// The review-CI observer deliberately has no dispatch or repair authority.
// Keeping it separate from the long-running worker loop lets a terminal CI
// transition be reported while an unrelated implementation worker is active.

let reportInFlight = false;

/**
 * Read and publish CI snapshots for retained review PRs. Every external
 * dependency is injected so this polling boundary is testable without a real
 * GitHub, Linear, or worktree.
 */
export async function reportReviewCi({
  linearClient,
  teamKey,
  inReviewStateName,
  WorktreeManager,
  worktreeManagerOptions,
  observePrFn,
  githubRepo,
  decideCiOutcome,
  reportObservationToLinear,
} = {}) {
  if (reportInFlight) return [];
  reportInFlight = true;
  try {
    const reviewIssues = await linearClient.issuesInState({ teamKey, stateName: inReviewStateName });
    const byIdentifier = new Map(reviewIssues.map((issue) => [issue.identifier, issue]));
    const manager = new WorktreeManager(worktreeManagerOptions);
    const results = [];
    for (const entry of Object.values(manager.loadState())) {
      if (entry.status !== "review" || !entry.prNumber) continue;
      const issue = byIdentifier.get(entry.id);
      if (!issue) continue;
      const observation = observePrFn(entry.prNumber, githubRepo);
      if (observation.observationError || !observation.headSha) continue;
      const events = (observation.checks?.checks || []).map((check) => ({ ...check, sha: check.sha || observation.headSha, conclusion: check.outcome }));
      const decision = decideCiOutcome({ prNumber: entry.prNumber, prUrl: entry.prUrl || null, headSha: observation.headSha, events });
      const existingBodies = typeof linearClient?.issueComments === "function"
        ? await linearClient.issueComments(issue.id)
        : [];
      results.push(await reportObservationToLinear({
        linearClient,
        issueId: issue.id,
        decision,
        observation: {
          requiredChecks: observation.checks.required.map((check) => check.name),
          requiredCheckStates: observation.checks.required.map((check) => ({ name: check.name, outcome: check.outcome })),
          missingRequired: observation.checks.missingRequired,
          pending: observation.checks.pending,
          timedOut: observation.checks.timedOut,
        },
        existingBodies,
      }));
    }
    return results;
  } finally {
    reportInFlight = false;
  }
}
