// The review-CI observer deliberately has no dispatch or repair authority.
// Keeping it separate from the long-running worker loop lets a terminal CI
// transition be reported while an unrelated implementation worker is active.

import { observationSnapshotKey } from "./ci-outcomes.mjs";

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
  escalateToOwner = null,
  needsHumanDecisionStateId = null,
  ownerLedger = null,
  botUserIds = [],
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
      const statusObservation = {
        requiredChecks: observation.checks.required.map((check) => check.name),
        requiredCheckStates: observation.checks.required.map((check) => ({ name: check.name, outcome: check.outcome })),
        missingRequired: observation.checks.missingRequired,
        pending: observation.checks.pending,
        timedOut: observation.checks.timedOut,
      };
      const existingBodies = typeof linearClient?.issueComments === "function"
        ? await linearClient.issueComments(issue.id, { untilContains: observationSnapshotKey({ decision, observation: statusObservation }) })
        : [];
      const report = await reportObservationToLinear({
        linearClient,
        issueId: issue.id,
        decision,
        observation: statusObservation,
        existingBodies,
      });
      results.push(report);

      // MOV-502: a terminal escalate decision is an ask of the owner. The
      // observer still gains no repair or dispatch authority: the only new
      // effect is the one escalation helper, once per observation key.
      const provisional = Boolean(statusObservation.pending) && !statusObservation.timedOut;
      if (decision.action === "escalate" && !provisional && escalateToOwner && needsHumanDecisionStateId) {
        const key = `escalation:${observationSnapshotKey({ decision, observation: statusObservation })}`;
        if (!existingBodies.some((body) => String(body || "").includes(key))) {
          const failing = [...new Set((decision.failures || []).map((event) => event.name || event.context || event.workflowName || "unknown-check"))];
          const prLabel = `PR #${decision.prNumber}${decision.prUrl ? ` (${decision.prUrl})` : ""}`;
          const outcome = await escalateToOwner({
            linearClient,
            issue,
            stateId: needsHumanDecisionStateId,
            ask: `CI on ${prLabel} needs a human decision: ${decision.reason}${failing.length ? ` (failing: ${failing.join(", ")})` : ""}`,
            evidence: [
              `**CI escalation** — ${prLabel}, SHA \`${decision.headSha}\``,
              `Failing checks: ${failing.length ? failing.join(", ") : "none named"}.`,
              `Reason: ${decision.reason}.`,
              `Escalation key: \`${key}\` (status record only; not a machine-control message).`,
            ].join("\n"),
            options: [
              "Move the issue back to `Ready for Agent` to retry.",
              "Fix the PR yourself and push; the dispatcher keeps observing it.",
              "Close the PR to drop it.",
            ],
            key,
            ledger: ownerLedger,
            botUserIds,
          });
          report.escalated = outcome.escalated;
        }
      }
    }
    return results;
  } finally {
    reportInFlight = false;
  }
}
