// Bounded automatic repair, executed (MOV-151).
//
// `repair-policy.mjs` decides; this runs one decision to completion and
// records what happened. It is the CI/review counterpart to `run-loop.mjs`
// and follows the same rules: every dependency is injected, every exit path
// leaves the ledger and the Linear issue coherent, and nothing is published
// that the audit has not already cleared.
//
// The shape that matters:
//
//   observe -> admit -> **reserve** -> act -> audit -> publish -> complete
//
// The reservation is before the action, not after. A dispatcher killed
// mid-repair therefore leaves an `in-progress` ledger record, which
// `admitRepair` reads on the next pass as "refuse and escalate" rather than
// as "nothing has been tried yet". Getting that order wrong is precisely how
// a bounded retry becomes an unbounded one.
//
// Two actions, deliberately asymmetric:
//
//   - **infrastructure-rerun** starts no worker and touches no file. A
//     transient failure is re-run, and if it was really transient the next
//     observation is green.
//   - **code-repair** runs a guarded worker in `repair` mode against the
//     retained worktree at the exact PR head, then publishes through
//     `publishRepairResult()`, which pushes to that PR's own branch without
//     force and never creates a replacement branch or PR.

import path from "node:path";
import { generateRepairBrief, generateRepairEvidence } from "./brief.mjs";
import { workerInvocation } from "./worker-routing.mjs";
import { tailLogs } from "./worker-spawn.mjs";
import { auditWorkerResult, writeWorkerAudit } from "./worker-guard.mjs";
import { admitRepair } from "./repair-policy.mjs";
import { DEFAULT_REPAIR_BUDGETS } from "./ci-outcomes.mjs";
import { LifecyclePublisher } from "./agent-lifecycle.mjs";
import { nullAgentSessionBridge } from "./agent-session.mjs";

const REPAIR_TIMEOUT = Symbol("repair-worker-timeout");

function raceTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(REPAIR_TIMEOUT), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function failureSummary(decision) {
  return (decision?.failures || []).map((failure) => ({
    check: failure.check,
    classification: failure.classification,
    reason: failure.reason,
    message: failure.message || failure.summary || null,
  }));
}

/**
 * Publish one stopping reason to Linear, exactly once per (PR, SHA, reason).
 *
 * The ledger is what makes it once: a poll loop re-derives the same refusal
 * every 30 seconds, and an escalation that re-comments every cycle is
 * indistinguishable from an escalation that is looping.
 */
async function escalateOnce({ entry, admission, publisher, ledger, stateIds, now }) {
  if (!admission.key || ledger.has(entry.id, admission.key)) {
    return { issue: entry.id, outcome: "repair-escalation-already-reported", reason: admission.reason };
  }
  ledger.recordEscalation(entry.id, {
    key: admission.key,
    prNumber: entry.prNumber,
    headSha: admission.headSha,
    fingerprints: admission.fingerprints,
    reason: admission.reason,
    now: now(),
  });
  await publisher.publish("error", {
    stateId: stateIds.needsHumanDecision,
    summary: `Automatic repair stopped for a human: ${admission.reason}`,
    headline: "**Automatic repair stopped and handed this PR to a human.**",
    sections: [
      `Pull request: ${entry.prUrl || `#${entry.prNumber}`} (head \`${admission.headSha || "unknown"}\`)`,
      `Stopping reason: ${admission.reason}`,
      admission.decision
        ? `Attempt budget: code repair ${admission.decision.attempts.codeRepair.used}/${admission.decision.attempts.codeRepair.limit}, infrastructure rerun ${admission.decision.attempts.infrastructureRerun.used}/${admission.decision.attempts.infrastructureRerun.limit}, total ${admission.decision.attempts.total.used}/${admission.decision.attempts.total.limit}.`
        : null,
      "",
      "No worker was started, no CI run was re-triggered, and nothing was pushed. See docs/operators/local-execution.md §Automatic repair.",
    ].filter(Boolean),
  });
  return { issue: entry.id, outcome: "repair-escalated", reason: admission.reason };
}

async function runInfrastructureRerun({ entry, admission, publisher, ledger, stateIds, ctx }) {
  const { rerunFailedChecksFn, ghRepo, now } = ctx;
  ledger.reserve(entry.id, {
    key: admission.key,
    kind: "infrastructure-rerun",
    prNumber: entry.prNumber,
    headSha: admission.headSha,
    fingerprints: admission.fingerprints,
    reason: admission.reason,
    now: now(),
  });
  let result;
  try {
    result = rerunFailedChecksFn({ repo: ghRepo, headSha: admission.headSha });
  } catch (error) {
    ledger.complete(entry.id, admission.key, { outcome: "failed", detail: error.message, now: now() });
    return escalateOnce({
      entry,
      admission: {
        ...admission,
        key: `${admission.key}:rerun-failed`,
        reason: `recognized transient failure could not be re-run: ${error.message}`,
      },
      publisher,
      ledger,
      stateIds,
      now,
    });
  }
  ledger.complete(entry.id, admission.key, {
    outcome: "reran",
    detail: result.reran.map((run) => run.id).join(", "),
    now: now(),
  });
  await publisher.publish("repair", {
    summary: `Re-ran ${result.reran.length} failed CI run(s) on ${admission.headSha} without any code change.`,
    headline: "**Automatic rerun of a recognized transient CI failure.**",
    sections: [
      `Pull request: ${entry.prUrl || `#${entry.prNumber}`} (head \`${admission.headSha}\`)`,
      `Reason: ${admission.reason}`,
      `Re-ran failed jobs in workflow run(s): ${result.reran.map((run) => `${run.name || "run"} (${run.id})`).join(", ")}`,
      "",
      "No worker ran and no file was changed — a transient infrastructure failure is not evidence that the code is wrong. This is the only rerun this PR gets; a second transient failure escalates.",
    ],
  });
  return { issue: entry.id, outcome: "repair-reran", prNumber: entry.prNumber, headSha: admission.headSha };
}

async function runCodeRepair({ issue, entry, admission, publisher, ledger, stateIds, ctx }) {
  const {
    worktreeManager,
    ghRepo,
    logRoot,
    spawnWorkerFn,
    workerTimeoutMs,
    auditWorkerResultFn,
    writeWorkerAuditFn,
    publishRepairResultFn,
    repairEvidenceFn,
    budgets,
    now,
  } = ctx;

  ledger.reserve(entry.id, {
    key: admission.key,
    kind: "code-repair",
    prNumber: entry.prNumber,
    headSha: admission.headSha,
    fingerprints: admission.fingerprints,
    reason: admission.reason,
    now: now(),
  });

  const attempt = admission.decision.attempts.codeRepair.used;
  const logDir = path.join(logRoot, `${entry.name}-repair-${admission.headSha.slice(0, 7)}`);
  const failures = failureSummary(admission.decision);

  await publisher.publish("repair", {
    summary: `Starting automatic repair attempt ${attempt}/${budgets.codeRepair} on ${entry.prUrl || `#${entry.prNumber}`} at ${admission.headSha}.`,
    headline: `**Starting automatic repair attempt ${attempt} of ${budgets.codeRepair}.**`,
    sections: [
      `Pull request: ${entry.prUrl || `#${entry.prNumber}`} (head \`${admission.headSha}\`)`,
      `Trigger: ${admission.trigger} — ${admission.reason}`,
      failures.length ? `Failing required checks: ${failures.map((f) => `\`${f.check}\` (${f.classification})`).join(", ")}` : null,
      "",
      `Run log: \`${logDir}\``,
    ].filter(Boolean),
  });

  const fail = async (reason, detail) => {
    ledger.complete(entry.id, admission.key, { outcome: "failed", detail: reason, now: now() });
    await publisher.publish("error", {
      stateId: stateIds.needsHumanDecision,
      summary: `Automatic repair attempt ${attempt} failed: ${reason}`,
      headline: `**Automatic repair attempt ${attempt} failed and was handed to a human.**`,
      sections: [
        `Pull request: ${entry.prUrl || `#${entry.prNumber}`} (head \`${admission.headSha}\`)`,
        `Reason: ${reason}`,
        ...(detail ? ["", "```", detail, "```"] : []),
        "",
        `Run log: \`${logDir}\`. Nothing was pushed by this attempt.`,
      ],
    });
    return { issue: entry.id, outcome: "repair-failed", reason };
  };

  const invocation = workerInvocation(entry.worker || "claude", entry.model || "default");
  const brief = generateRepairBrief(issue, {
    branch: entry.branch,
    worktreePath: entry.path,
    worker: entry.worker,
    model: entry.model,
    prNumber: entry.prNumber,
    prUrl: entry.prUrl,
    headSha: admission.headSha,
    failures,
    attempt,
    attemptLimit: budgets.codeRepair,
    evidence: generateRepairEvidence(repairEvidenceFn(entry, admission)),
  });

  const abortController = new AbortController();
  let spawnResult;
  try {
    spawnResult = await raceTimeout(
      spawnWorkerFn({
        invocation,
        cwd: entry.path,
        brief,
        logDir,
        signal: abortController.signal,
        securityContext: { mode: "repair" },
      }),
      workerTimeoutMs,
    );
  } catch (error) {
    return fail(`repair worker could not start under the required safety boundary: ${error.message}`);
  }
  if (spawnResult === REPAIR_TIMEOUT) {
    abortController.abort();
    return fail(`repair worker timed out after ${workerTimeoutMs}ms and was killed`, tailLogs(logDir, 30));
  }

  // The audit runs before the exit code is judged, and its verdict wins:
  // a worker that exited 0 having attempted a protected change must not be
  // published, and one that exited non-zero has still left a transcript worth
  // recording. Same ordering as run-loop.mjs, same reason.
  let securityReport;
  let auditRecord;
  try {
    securityReport = auditWorkerResultFn({
      worktreePath: entry.path,
      branch: entry.branch,
      logDir,
      mode: "repair",
    });
    auditRecord = writeWorkerAuditFn(logDir, {
      issue: entry.id,
      worker: entry.worker,
      phase: "repair",
      repairKey: admission.key,
      exitCode: spawnResult.exitCode,
      ...securityReport,
    });
  } catch (error) {
    securityReport = { ok: false, violations: [{ action: "security audit", reason: `audit could not complete: ${error.message}` }] };
  }
  if (!securityReport.ok) {
    return fail(
      `repair worker safety boundary blocked publication: ${securityReport.violations.map((violation) => violation.reason).join("; ")}`,
      auditRecord?.path ? `Audit record: ${auditRecord.path} (SHA-256 ${auditRecord.sha256})` : null,
    );
  }
  if (spawnResult.exitCode !== 0) {
    return fail(`repair worker exited with code ${spawnResult.exitCode}`, tailLogs(logDir, 50));
  }

  let pr;
  try {
    pr = publishRepairResultFn({
      worktreePath: entry.path,
      branch: entry.branch,
      repo: ghRepo,
      issue,
      expectedHeadSha: admission.headSha,
    });
  } catch (error) {
    return fail(`dispatcher refused or failed to publish the audited repair: ${error.message}`);
  }

  ledger.complete(entry.id, admission.key, {
    outcome: "published",
    detail: pr.url || null,
    headSha: pr.headSha || null,
    now: now(),
  });
  // Keep the registry's recorded head in step with what was just pushed, so
  // the next observation compares against the SHA this repair produced rather
  // than the one it repaired.
  if (typeof worktreeManager.updateEntry === "function" && pr.headSha) {
    worktreeManager.updateEntry(entry.id, { headSha: pr.headSha });
  }
  await publisher.publish("repair", {
    summary: `Automatic repair attempt ${attempt}/${budgets.codeRepair} published to ${pr.url || `#${entry.prNumber}`}.`,
    headline: `**Automatic repair attempt ${attempt} of ${budgets.codeRepair} published.**`,
    sections: [
      `Pull request: ${pr.url || `#${entry.prNumber}`}`,
      `Repaired \`${admission.headSha}\`; new head \`${pr.headSha || "(reported by GitHub on the next observation)"}\`.`,
      `Fixed: ${failures.map((failure) => `\`${failure.check}\``).join(", ") || "the failing required checks"}.`,
      "",
      "CI will now run against the new head. If it is green this PR proceeds normally; if it fails again, the remaining attempt budget applies and is reported here.",
      "",
      `Audit record: \`${auditRecord?.path || logDir}\`${auditRecord?.sha256 ? ` (SHA-256 \`${auditRecord.sha256}\`)` : ""}`,
    ],
  });
  return { issue: entry.id, outcome: "repair-published", prNumber: entry.prNumber, headSha: pr.headSha || null };
}

/**
 * One automatic-repair pass over every PR the dispatcher is still watching.
 *
 * @param {object} ctx
 * @param {object} ctx.linearClient
 * @param {Record<string,string>} ctx.stateIds - needs `needsHumanDecision`
 * @param {object} ctx.worktreeManager
 * @param {import("./repair-ledger.mjs").RepairLedger} ctx.ledger
 * @param {Map<string, object>} ctx.issuesByIdentifier - live Linear issues in "In Review", keyed by identifier
 * @param {string} ctx.ghRepo - "owner/name"
 * @param {string} ctx.logRoot
 * @param {(prNumber: number, repo: string) => object} ctx.observePrFn
 * @param {(worktreePath: string) => string|null} ctx.resolveHeadShaFn - HEAD of the dispatcher-owned checkout
 * @param {(args: object) => Promise<{exitCode: number, logDir: string}>} ctx.spawnWorkerFn
 * @param {(args: object) => object} ctx.publishRepairResultFn
 * @param {(args: object) => object} ctx.rerunFailedChecksFn
 * @param {(entry: object, admission: object) => object} [ctx.repairEvidenceFn] - untrusted diagnostic data for the brief
 * @param {boolean} [ctx.enabled] - the MOVIECAL_AUTO_REPAIR switch; off means observe-and-report only
 * @param {string[]} [ctx.trustedReviewers]
 * @param {object} [ctx.budgets]
 * @returns {Promise<Array<{issue: string, outcome: string, [key: string]: unknown}>>}
 */
export async function repairPass(ctx) {
  const {
    linearClient,
    stateIds,
    worktreeManager,
    ledger,
    issuesByIdentifier,
    ghRepo,
    observePrFn,
    resolveHeadShaFn = () => null,
    repairEvidenceFn = () => ({}),
    auditWorkerResultFn = auditWorkerResult,
    writeWorkerAuditFn = writeWorkerAudit,
    agentSessionBridgeFn = () => nullAgentSessionBridge(),
    enabled = false,
    trustedReviewers = [],
    budgets = DEFAULT_REPAIR_BUDGETS,
    now = () => new Date(),
    logger = console,
  } = ctx;

  const results = [];
  for (const entry of Object.values(worktreeManager.loadState())) {
    if (entry.status !== "review" || !entry.prNumber) continue;
    const issue = issuesByIdentifier.get(entry.id);
    if (!issue) continue;

    let observation;
    try {
      observation = observePrFn(entry.prNumber, ghRepo);
    } catch (error) {
      logger.error(`${entry.id}: could not observe PR #${entry.prNumber} for repair (retrying next pass): ${error.message}`);
      continue;
    }

    let localHeadSha = null;
    try {
      localHeadSha = resolveHeadShaFn(entry.path);
    } catch {
      // A worktree that cannot be read is caught by validateRepairTarget's
      // provenance checks below; leaving this null just skips the explicit
      // "checkout is behind the PR head" message in favour of that one.
    }

    const admission = admitRepair({
      entry,
      observation,
      repository: ghRepo,
      localHeadSha,
      previousAttempts: ledger.previousAttempts(entry.id, entry.prNumber),
      reservedKeys: ledger.attempts(entry.id).map((attempt) => attempt.key),
      unfinishedAttempt: ledger.unfinished(entry.id, entry.prNumber),
      budgets,
      trustedReviewers,
      enabled,
    });

    if (admission.action === "ignore") {
      results.push({ issue: entry.id, outcome: "repair-skipped", reason: admission.reason });
      continue;
    }

    const publisher = new LifecyclePublisher({
      linearClient,
      bridge: agentSessionBridgeFn(),
      logger,
      context: {
        issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
        branch: entry.branch,
        worktreePath: entry.path,
        worker: entry.worker,
        model: entry.model,
        prUrl: entry.prUrl,
      },
    });
    await publisher.begin({ existing: entry.agentSession || null });

    try {
      if (admission.action === "escalate") {
        results.push(await escalateOnce({ entry, admission, publisher, ledger, stateIds, now }));
      } else if (admission.action === "infrastructure-rerun") {
        results.push(await runInfrastructureRerun({ entry, admission, publisher, ledger, stateIds, ctx: { ...ctx, now } }));
      } else {
        results.push(
          await runCodeRepair({
            issue,
            entry,
            admission,
            publisher,
            ledger,
            stateIds,
            ctx: { ...ctx, auditWorkerResultFn, writeWorkerAuditFn, budgets, now },
          }),
        );
      }
    } catch (error) {
      // One PR's repair must never abort the sweep over the others. The
      // reservation stays `in-progress`, which the next pass reads as
      // "refuse and escalate" — the safe reading of an unknown outcome.
      logger.error(`${entry.id}: automatic repair pass failed: ${error.message}`);
      results.push({ issue: entry.id, outcome: "repair-error", reason: error.message });
    }
  }
  return results;
}
