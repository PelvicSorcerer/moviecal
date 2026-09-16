// Executing the bounded repair decisions (MOV-190).
//
// MOV-189 built every primitive this needs and deliberately wired none of them
// together: `admitRepair()` decides, `RepairLedger` remembers, `repair-github`
// reruns and comments, `generateRepairBrief` briefs, `publishRepairResult`
// pushes. Nothing called them, so automatic repair was a decision nobody acted
// on. This module is the act — and it is the only place in the dispatcher that
// starts a worker against code that is already in review.
//
// Everything here is dependency-injected, the same way `run-loop.mjs` is: the
// orchestration is the part worth getting right, and it is only worth getting
// right if it can be tested without a Mac, a worktree, or a GitHub token.
//
// Four properties this file exists to hold:
//
//   1. **Reserve before acting, complete after.** Every path that starts a
//      worker or touches GitHub sits between a `reserve()` and a `complete()`.
//      A dispatcher that dies in the middle leaves an `in-progress` attempt,
//      which `admitRepair()` refuses to start a second worker against.
//   2. **One repair worker at a time, and never more than the budget.** The
//      per-PR budget is `admitRepair()`'s; the per-pass cap is here, because
//      the Mac adapter is single-flight and a repair worker contends for the
//      same Xcode/runner resources as a dispatch worker.
//   3. **A rerun is not a repair.** The infrastructure path re-runs failed
//      jobs and nothing else: no worker starts, no file changes, no push.
//   4. **A stopping reason is published at most once, durably.** The poll loop
//      re-observes the same failing PR every 30 seconds. Per-process memory
//      cannot make "at most once" true across a restart; the ledger can.
//
// The refusals are as important as the actions. A dirty checkout, an
// unreadable HEAD, a stale head SHA, a fork, an unaudited worker result, or a
// PR whose identity changed under us all stop the repair and hand the target to
// a human — see `admitRepair()` and `validateRepairTarget()` for the admission
// half, and `guardTarget()` below for the two conditions only the executor can
// see.

import path from "node:path";
import { generateRepairBrief, generateRepairEvidence } from "./brief.mjs";
import { DEFAULT_REPAIR_BUDGETS } from "./ci-outcomes.mjs";
import { admitRepair } from "./repair-policy.mjs";
import { repairJobKey } from "./repair-ledger.mjs";
import { workerInvocation } from "./worker-routing.mjs";
import { tailLogs } from "./worker-spawn.mjs";
import { LifecyclePublisher } from "./agent-lifecycle.mjs";
import { nullAgentSessionBridge } from "./agent-session.mjs";

/** The worker mode every repair runs in — stricter sandbox, stricter diff audit. */
export const REPAIR_WORKER_MODE = "repair";

/**
 * How many repair workers one pass may start. One, because the Mac adapter is
 * single-flight (config.mjs `DEFAULT_CONCURRENCY`) and a repair worker is as
 * expensive as a dispatch worker. A second admitted target is not refused, just
 * left for the next cycle — no ledger key is reserved for it, so the next pass
 * admits it from scratch.
 */
export const DEFAULT_MAX_REPAIR_WORKERS_PER_PASS = 1;

/**
 * Every injected dependency a pass cannot safely run without. Half are
 * refusal probes (an observation, the local HEAD, the dirty-path list) and
 * half are privileged mutations (the worker, the audit, the publisher, the
 * rerun, the PR comment). A pass missing any of them would either act without
 * a guard or claim to act and not, so this throws rather than degrading.
 */
const REQUIRED_DEPENDENCIES = Object.freeze([
  "observePrFn",
  "localHeadShaFn",
  "uncommittedChangesFn",
  "issueForEntryFn",
  "spawnWorkerFn",
  "auditWorkerResultFn",
  "writeWorkerAuditFn",
  "publishRepairResultFn",
  "rerunFailedJobsFn",
  "collectRepairEvidenceFn",
  "commentOnPullRequestFn",
]);

const REPAIR_TIMEOUT = Symbol("repair-worker-timeout");

/** Race a repair worker against its timeout; a non-positive timeout disables it. */
function raceRepairTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(REPAIR_TIMEOUT), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function shortSha(value) {
  return String(value ?? "unknown").slice(0, 12);
}

/**
 * Both surfaces one repair target reports on: the Linear lifecycle (through
 * `LifecyclePublisher`, so a repair reads as a continuation of the attempt that
 * opened the PR rather than a stranger commenting on it) and one plain PR
 * comment, which is the half an operator looking at GitHub actually sees.
 *
 * Every method is best-effort and swallows its own failures. A repair that
 * fixed the code and pushed it has succeeded even if Linear was briefly
 * unreachable; failing it because the *notification* failed would convert a
 * transient outage into a completed-but-unreported attempt, which is strictly
 * worse than a missing comment.
 */
class RepairReporter {
  constructor(entry, ctx) {
    this.entry = entry;
    this.ctx = ctx;
    this.logger = ctx.logger || console;
    this._issue = undefined;
    this._publisher = undefined;
  }

  /**
   * The Linear issue behind this PR, read at most once per target per pass.
   * Deliberately lazy: the overwhelmingly common outcome is "nothing to
   * repair", and that outcome should cost no Linear call at all.
   */
  async issue() {
    if (this._issue === undefined) {
      try {
        this._issue = (await this.ctx.issueForEntryFn(this.entry)) || null;
      } catch (error) {
        this.logger.error(`${this.entry.id}: could not read the Linear issue for repair: ${error.message}`);
        this._issue = null;
      }
    }
    return this._issue;
  }

  async publisher() {
    if (this._publisher !== undefined) return this._publisher;
    const issue = await this.issue();
    if (!issue || !this.ctx.linearClient) {
      this._publisher = null;
      return null;
    }
    const {
      linearClient,
      agentSessionBridgeFn = () => nullAgentSessionBridge(),
      readAgentSessionFn = () => null,
    } = this.ctx;
    const publisher = new LifecyclePublisher({
      linearClient,
      bridge: agentSessionBridgeFn(),
      logger: this.logger,
      context: {
        issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
        branch: this.entry.branch,
        worktreePath: this.entry.path,
        worker: this.entry.worker,
        model: this.entry.model,
        prUrl: this.entry.prUrl || null,
      },
    });
    try {
      await publisher.begin({ existing: readAgentSessionFn(this.entry.id) });
    } catch (error) {
      this.logger.error(`${this.entry.id}: could not attach the repair lifecycle session: ${error.message}`);
    }
    this._publisher = publisher;
    return publisher;
  }

  /** Publish one lifecycle event. Never throws into the repair path. */
  async publish(kind, fields) {
    const publisher = await this.publisher();
    if (!publisher) return { surface: "none", key: null, reason: "no Linear issue or client available" };
    try {
      return await publisher.publish(kind, fields);
    } catch (error) {
      this.logger.error(`${this.entry.id}: could not publish the repair lifecycle event: ${error.message}`);
      return { surface: "none", key: null, reason: error.message };
    }
  }

  /**
   * One plain PR comment — never a GitHub review. The dispatcher has no
   * approval semantics anywhere and repair does not acquire any.
   */
  comment(body) {
    try {
      this.ctx.commentOnPullRequestFn({ prNumber: this.entry.prNumber, repo: this.ctx.ghRepo, body });
      return true;
    } catch (error) {
      this.logger.error(`${this.entry.id}: could not comment on PR #${this.entry.prNumber}: ${error.message}`);
      return false;
    }
  }

  /** Flush the activity retry queue and persist the session record, if either exists. */
  async finish() {
    if (!this._publisher) return;
    try {
      await this._publisher.flushPending();
    } catch (error) {
      this.logger.error(`${this.entry.id}: could not flush queued repair activities: ${error.message}`);
    }
    try {
      this.ctx.persistAgentSessionFn?.(this.entry.id, this._publisher.snapshot());
    } catch (error) {
      this.logger.error(`${this.entry.id}: could not persist the repair session record: ${error.message}`);
    }
  }
}

/**
 * Publish one terminal stopping reason for a repair target, at most once ever.
 *
 * The at-most-once guarantee is the ledger's, not this process's: a 30-second
 * poll loop re-derives the same refusal on every cycle, and an operator who is
 * shown the same stop 2,880 times a day has effectively been shown it zero
 * times. The key is the ledger's own job identity (PR + head SHA + kind +
 * failure fingerprints), so a genuinely different refusal, or the same refusal
 * against genuinely different code, still gets through.
 *
 * The ledger write happens **before** the publish, deliberately. A crash
 * between the two loses one notification (the reason is still recorded, and the
 * PR is still failing, so nothing is silently "fixed"); the reverse order risks
 * re-publishing forever, which is the failure this criterion names.
 */
async function publishStop({ entry, ctx, reporter, key = null, headSha, fingerprints = [], reason, sections = [], outcome = "escalated" }) {
  const { ledger, stateIds = {}, now = () => new Date() } = ctx;
  const jobKey = key || repairJobKey({ prNumber: entry.prNumber, headSha, kind: "escalation", fingerprints });

  if (ledger.has(entry.id, jobKey)) {
    return { issue: entry.id, outcome: "stop-already-published", reason, key: jobKey };
  }
  ledger.recordEscalation(entry.id, {
    key: jobKey,
    prNumber: entry.prNumber,
    headSha,
    fingerprints,
    reason,
    now: now(),
  });

  const headline = `**Automatic repair stopped and handed PR #${entry.prNumber} to a human.**`;
  const body = [
    headline,
    "",
    `Reason: ${reason}`,
    `Head SHA: \`${headSha}\``,
    `Branch: \`${entry.branch}\``,
    ...sections,
    "",
    `Repair job key: \`${jobKey}\` — this stopping reason is recorded in the dispatcher's repair ledger and will not be repeated for this commit.`,
  ];

  await reporter.publish("error", {
    stateId: stateIds.needsHumanDecision,
    summary: `Automatic repair stopped on PR #${entry.prNumber}: ${reason}`,
    headline,
    sections: body.slice(2),
  });
  reporter.comment(body.join("\n"));

  return { issue: entry.id, outcome, reason, key: jobKey };
}

/**
 * The two refusals only the executor can see, because they are properties of
 * the dispatcher-owned checkout rather than of the PR.
 *
 * A **dirty** worktree is refused because `publishRepairResult()` stages
 * everything: a repair on top of unrelated uncommitted work would commit that
 * work too, under a repair commit message, with nobody having audited it. It
 * is also the state a previously-failed repair leaves behind, which is exactly
 * when a second automatic attempt is least safe.
 *
 * An **unreadable HEAD** is refused because the staleness comparison in
 * `admitRepair()` is what proves the repair would edit the code GitHub tested.
 * With no local SHA there is nothing to compare, and "no evidence of staleness"
 * is not the same as "fresh".
 */
function guardTarget({ entry, ctx }) {
  const { uncommittedChangesFn, localHeadShaFn } = ctx;

  const dirtyPaths = uncommittedChangesFn(entry.path) || [];
  if (dirtyPaths.length) {
    return {
      ok: false,
      fingerprints: ["dirty-worktree"],
      reason:
        `the retained worktree at ${entry.path} has ${dirtyPaths.length} uncommitted path(s) ` +
        `(${dirtyPaths.slice(0, 10).join(", ")}${dirtyPaths.length > 10 ? ", …" : ""}); ` +
        "automatic repair only ever edits a clean checkout of the exact code GitHub tested",
      sections: ["", "Uncommitted paths:", "```", dirtyPaths.join("\n"), "```"],
    };
  }

  const localHeadSha = localHeadShaFn(entry.path) || null;
  if (!localHeadSha) {
    return {
      ok: false,
      fingerprints: ["unreadable-local-head"],
      reason:
        `the dispatcher-owned checkout at ${entry.path} did not report a HEAD commit, ` +
        "so automatic repair cannot prove it would edit the code GitHub tested",
      sections: [],
    };
  }

  return { ok: true, localHeadSha };
}

/**
 * Re-run the failed jobs of a transient CI failure. No worker starts, no file
 * in the repository changes, and nothing is pushed — the whole action is
 * `gh run rerun --failed` on the admitted commit.
 */
async function runInfrastructureRerun({ entry, ctx, decision, reporter }) {
  const { ledger, ghRepo, rerunFailedJobsFn, now = () => new Date() } = ctx;

  ledger.reserve(entry.id, {
    key: decision.key,
    kind: "infrastructure-rerun",
    prNumber: entry.prNumber,
    headSha: decision.headSha,
    fingerprints: decision.fingerprints,
    reason: decision.reason,
    now: now(),
  });

  let rerun;
  try {
    rerun = rerunFailedJobsFn({ prNumber: entry.prNumber, repo: ghRepo, headSha: decision.headSha });
  } catch (error) {
    ledger.complete(entry.id, decision.key, { outcome: "failed", detail: error.message, now: now() });
    return publishStop({
      entry,
      ctx,
      reporter,
      headSha: decision.headSha,
      fingerprints: decision.fingerprints,
      reason: `re-running the failed jobs for PR #${entry.prNumber} at ${decision.headSha} failed: ${error.message}`,
      outcome: "rerun-failed",
    });
  }

  // Nothing rerun means nothing was done, and the reserved key now blocks a
  // second attempt at this same failure — so this has to surface as a stop
  // rather than as a success that quietly changed nothing.
  if (!rerun?.rerun?.length) {
    const detail = "no rerunnable failed workflow run at the admitted head SHA";
    ledger.complete(entry.id, decision.key, { outcome: "failed", detail, now: now() });
    return publishStop({
      entry,
      ctx,
      reporter,
      headSha: decision.headSha,
      fingerprints: decision.fingerprints,
      reason: `${detail}; automatic repair has no transient failure it can clear here`,
      sections: (rerun?.skipped || []).length
        ? ["", "Runs considered and skipped:", ...rerun.skipped.map((run) => `- \`${run.name || run.id}\`: ${run.reason}`)]
        : [],
      outcome: "rerun-failed",
    });
  }

  ledger.complete(entry.id, decision.key, {
    outcome: "reran",
    detail: rerun.rerun.map((run) => run.name || run.id).join(", "),
    headSha: decision.headSha,
    now: now(),
  });

  const reran = rerun.rerun.map((run) => `- \`${run.name || run.id}\` (was ${run.conclusion || "failing"})`);
  const sections = [
    `Re-ran the failed jobs of ${rerun.rerun.length} workflow run(s) on \`${decision.headSha}\`:`,
    ...reran,
    "",
    "No repair worker was started, no file in the repository was changed, and nothing was pushed. If the same failure returns, it is not transient and the next pass will treat it accordingly.",
    ...(rerun.errors?.length ? ["", "Reruns that could not be requested:", ...rerun.errors.map((run) => `- \`${run.name || run.id}\`: ${run.message}`)] : []),
  ];

  await reporter.publish("repair", {
    summary: `Re-ran ${rerun.rerun.length} failed CI run(s) for PR #${entry.prNumber} at ${decision.headSha}: ${decision.reason}`,
    headline: `**Automatic repair re-ran the failed CI jobs for PR #${entry.prNumber}.**`,
    sections,
  });
  reporter.comment([`**Automatic repair: transient CI failure, re-running failed jobs only.**`, "", ...sections].join("\n"));

  return {
    issue: entry.id,
    outcome: "rerun",
    reason: decision.reason,
    key: decision.key,
    reran: rerun.rerun.length,
  };
}

/** Close out a reserved code-repair attempt that did not publish, and stop. */
async function failCodeRepair({ entry, ctx, decision, reporter, reason, logDir = null }) {
  const { ledger, uncommittedChangesFn, now = () => new Date(), logger = console } = ctx;
  ledger.complete(entry.id, decision.key, { outcome: "failed", detail: reason, now: now() });

  // The worker's output is never discarded — a failed repair is exactly the
  // case where a human needs to see what it did before deciding anything.
  let retained = [];
  try {
    retained = uncommittedChangesFn(entry.path) || [];
  } catch (error) {
    logger.error(`${entry.id}: could not list the retained repair changes: ${error.message}`);
  }

  const sections = [
    "",
    "The repair worker's changes were **not** published: nothing was committed and nothing was pushed. The pull request is exactly as CI last saw it.",
    ...(retained.length
      ? ["", "Retained (uncommitted) paths in the worktree, left for human review:", "```", retained.join("\n"), "```"]
      : []),
    ...(logDir ? ["", `Full run log: \`${logDir}\``] : []),
  ];

  return publishStop({
    entry,
    ctx,
    reporter,
    headSha: decision.headSha,
    fingerprints: decision.fingerprints,
    reason,
    sections,
    outcome: "repair-failed",
  });
}

/**
 * Start one bounded repair worker on the retained checkout, audit it, and
 * publish it onto the same PR at the admitted head SHA.
 */
async function runCodeRepair({ entry, issue, ctx, decision, observation, reporter, passBudget }) {
  const {
    ledger,
    ghRepo,
    logRoot,
    workerTimeoutMs,
    budgets = DEFAULT_REPAIR_BUDGETS,
    worktreeManager,
    spawnWorkerFn,
    auditWorkerResultFn,
    writeWorkerAuditFn,
    publishRepairResultFn,
    collectRepairEvidenceFn,
    repositoryContextFn,
    workerInvocationFn = workerInvocation,
    now = () => new Date(),
    logger = console,
  } = ctx;

  ledger.reserve(entry.id, {
    key: decision.key,
    kind: "code-repair",
    prNumber: entry.prNumber,
    headSha: decision.headSha,
    fingerprints: decision.fingerprints,
    reason: decision.reason,
    now: now(),
  });
  passBudget.workersStarted += 1;

  // Counted after the reservation, so this reads as "attempt N of the budget"
  // including the one about to run — which is what the brief promises.
  const attempt = ledger.previousAttempts(entry.id, entry.prNumber).codeRepair;
  const logDir = path.join(logRoot, `${entry.name}-repair-${shortSha(decision.headSha)}`);

  // Untrusted diagnostic data, and fail-soft on purpose: a missing log is a
  // thinner brief, not a failed repair.
  let evidence = null;
  try {
    evidence = generateRepairEvidence(
      collectRepairEvidenceFn({ prNumber: entry.prNumber, repo: ghRepo, headSha: decision.headSha }),
    );
  } catch (error) {
    logger.error(`${entry.id}: could not collect repair evidence (continuing with a thinner brief): ${error.message}`);
  }

  let repositoryContext = null;
  if (typeof repositoryContextFn === "function") {
    try {
      repositoryContext = repositoryContextFn({ worktreePath: entry.path, branch: entry.branch });
    } catch (error) {
      logger.error(`${entry.id}: could not collect repository context (continuing): ${error.message}`);
    }
  }

  const brief = generateRepairBrief(issue, {
    branch: entry.branch,
    worktreePath: entry.path,
    worker: entry.worker,
    model: entry.model,
    prNumber: entry.prNumber,
    prUrl: entry.prUrl || observation.url || null,
    headSha: decision.headSha,
    attempt,
    budget: budgets.codeRepair,
    failures: decision.decision?.failures || [],
    trigger: decision.trigger,
    reason: decision.reason,
    evidence,
    repositoryContext,
  });

  await reporter.publish("repair", {
    summary: `Starting bounded repair attempt ${attempt} of ${budgets.codeRepair} on PR #${entry.prNumber} at ${decision.headSha}.`,
    headline: `**Automatic repair started on PR #${entry.prNumber}** (attempt ${attempt} of ${budgets.codeRepair}).`,
    sections: [
      `Reason: ${decision.reason}`,
      `Trigger: ${decision.trigger === "review" ? "a blocking review verdict" : "a failing required CI check"}`,
      `Head SHA: \`${decision.headSha}\``,
      `Worktree: \`${entry.path}\` (retained, dispatcher-owned)`,
      "",
      "The repair worker runs in repair mode: tests, test-runner configuration, dispatcher code, staged workflow proposals, and governance documentation are read-only, and it has no Git or GitHub authority of its own.",
    ],
  });

  // The abort signal is what kills the worker's process group on timeout,
  // exactly as run-loop.mjs does for a dispatch worker.
  const abortController = new AbortController();
  let spawnResult;
  try {
    const workerPromise = spawnWorkerFn({
      invocation: workerInvocationFn(entry.worker || "claude", entry.model || "default"),
      cwd: entry.path,
      brief,
      logDir,
      signal: abortController.signal,
      securityContext: { mode: REPAIR_WORKER_MODE },
    });
    // The race below owns this rejection; this no-op handler only stops Node
    // reporting the loser of the race as an unhandled rejection.
    Promise.resolve(workerPromise).catch(() => {});
    spawnResult = await raceRepairTimeout(workerPromise, workerTimeoutMs);
  } catch (error) {
    try {
      writeWorkerAuditFn(logDir, {
        issue: entry.id,
        worker: entry.worker,
        phase: "repair-spawn",
        ok: false,
        violations: [{ action: "worker safety boundary", reason: error.message }],
      });
    } catch {
      // The Linear/PR record below remains the audit backstop when local
      // audit storage is itself unavailable. Never weaken the fail-closed path.
    }
    return failCodeRepair({
      entry,
      ctx,
      decision,
      reporter,
      reason: `the repair worker could not start under the required safety boundary: ${error.message}`,
      logDir,
    });
  }

  if (spawnResult === REPAIR_TIMEOUT) {
    abortController.abort();
    return failCodeRepair({
      entry,
      ctx,
      decision,
      reporter,
      reason: `the repair worker did not exit within ${workerTimeoutMs}ms and its process group was killed`,
      logDir,
    });
  }

  if (spawnResult?.exitCode !== 0) {
    return failCodeRepair({
      entry,
      ctx,
      decision,
      reporter,
      reason: `the repair worker exited with code ${spawnResult?.exitCode}`,
      logDir,
    });
  }

  let audit;
  let auditRecord;
  try {
    audit = auditWorkerResultFn({
      worktreePath: entry.path,
      branch: entry.branch,
      logDir,
      mode: REPAIR_WORKER_MODE,
      // Measured from the admitted commit, not origin/master: the PR's
      // existing history was produced and audited in implementation mode, and
      // re-judging it here would fail every repair of a PR that legitimately
      // touched a repair-protected path. See auditWorkerResult (MOV-190).
      baseRef: decision.headSha,
    });
    auditRecord = writeWorkerAuditFn(logDir, {
      issue: entry.id,
      worker: entry.worker,
      phase: "repair",
      prNumber: entry.prNumber,
      headSha: decision.headSha,
      repairKey: decision.key,
      exitCode: spawnResult.exitCode,
      ...audit,
    });
  } catch (error) {
    audit = { ok: false, violations: [{ action: "security audit", reason: `audit could not complete: ${error.message}` }] };
  }

  if (!audit.ok) {
    return failCodeRepair({
      entry,
      ctx,
      decision,
      reporter,
      reason:
        "the repair worker's result failed the security audit: " +
        audit.violations.map((violation) => `${violation.reason} (\`${String(violation.action).slice(0, 200)}\`)`).join("; "),
      logDir,
    });
  }

  let pr;
  try {
    pr = publishRepairResultFn({
      worktreePath: entry.path,
      branch: entry.branch,
      repo: ghRepo,
      issue,
      expectedHeadSha: decision.headSha,
    });
  } catch (error) {
    return failCodeRepair({
      entry,
      ctx,
      decision,
      reporter,
      reason: `the dispatcher refused or failed to publish the audited repair: ${error.message}`,
      logDir,
    });
  }

  // `publishRepairResult()` already refuses to publish anywhere but this
  // branch and this PR. Re-checking the returned identity costs nothing and
  // keeps "a successful repair only ever touched the same dispatcher-owned PR
  // branch" true of this module in its own right.
  if (!pr || pr.number !== entry.prNumber) {
    return failCodeRepair({
      entry,
      ctx,
      decision,
      reporter,
      reason: pr
        ? `repair publication returned PR #${pr.number} instead of the admitted PR #${entry.prNumber}`
        : "the trusted repair publisher returned no pull request",
      logDir,
    });
  }

  ledger.complete(entry.id, decision.key, {
    outcome: "published",
    detail: pr.url || null,
    headSha: pr.headSha || null,
    now: now(),
  });
  // The push produced a new head. Record it so the registry reflects what is
  // actually checked out; best-effort, because losing this costs bookkeeping
  // accuracy and never correctness (`admitRepair()` reads the live
  // observation's head, not this field).
  try {
    worktreeManager?.updateEntry?.(entry.id, { headSha: pr.headSha || null });
  } catch (error) {
    logger.error(`${entry.id}: could not record the repaired head SHA: ${error.message}`);
  }

  const sections = [
    `Reason: ${decision.reason}`,
    `Repair attempt: ${attempt} of ${budgets.codeRepair} for this pull request.`,
    `Pushed to the same branch \`${entry.branch}\`; new head \`${pr.headSha || "unknown"}\` (was \`${decision.headSha}\`).`,
    "",
    "No branch and no pull request were created. GitHub CI is authoritative for whether the repair worked.",
    ...(logDir ? ["", `Full run log: \`${logDir}\``] : []),
    ...(auditRecord?.path ? [`Audit record: \`${auditRecord.path}\`${auditRecord.sha256 ? ` (SHA-256 \`${auditRecord.sha256}\`)` : ""}`] : []),
  ];

  await reporter.publish("repair", {
    summary: `Published bounded repair attempt ${attempt} to PR #${entry.prNumber} (${pr.url || entry.prUrl || "no URL"}).`,
    headline: `**Automatic repair published to PR #${entry.prNumber}.**`,
    sections,
  });
  reporter.comment(
    [`**Automatic repair pushed a fix to this pull request.**`, "", ...sections, "", "```", tailLogs(logDir, 20), "```"].join("\n"),
  );

  return {
    issue: entry.id,
    outcome: "repaired",
    reason: decision.reason,
    key: decision.key,
    pr: pr.url || entry.prUrl || null,
    headSha: pr.headSha || null,
  };
}

/** Decide and execute at most one repair action for one retained review target. */
async function repairOneTarget(entry, ctx, passBudget) {
  const {
    ledger,
    ghRepo,
    budgets = DEFAULT_REPAIR_BUDGETS,
    trustedReviewers = [],
    enabled = false,
    concurrencyLimit = 1,
    worktreeManager,
    observePrFn,
  } = ctx;

  const observation = await observePrFn(entry.prNumber, ghRepo);
  if (!observation || observation.observationError || !observation.headSha) {
    // Not a refusal worth publishing: GitHub was briefly unreadable, which
    // says nothing about the target. The next pass retries.
    return {
      issue: entry.id,
      outcome: "unobservable",
      reason: observation?.observationError?.message || "PR observation carried no head SHA",
    };
  }

  const reporter = new RepairReporter(entry, ctx);
  try {
    const guard = guardTarget({ entry, ctx });
    if (!guard.ok) {
      return await publishStop({
        entry,
        ctx,
        reporter,
        headSha: observation.headSha,
        fingerprints: guard.fingerprints,
        reason: guard.reason,
        sections: guard.sections,
        outcome: "refused",
      });
    }

    const decision = admitRepair({
      entry,
      observation,
      repository: ghRepo,
      localHeadSha: guard.localHeadSha,
      previousAttempts: ledger.previousAttempts(entry.id, entry.prNumber),
      reservedKeys: ledger.attempts(entry.id).map((attempt) => attempt.key),
      unfinishedAttempt: ledger.unfinished(entry.id, entry.prNumber),
      budgets,
      trustedReviewers,
      enabled,
    });

    if (decision.action === "ignore") {
      return { issue: entry.id, outcome: "ignored", reason: decision.reason };
    }
    if (decision.action === "escalate") {
      return await publishStop({
        entry,
        ctx,
        reporter,
        key: decision.key,
        headSha: decision.headSha || observation.headSha,
        fingerprints: decision.fingerprints,
        reason: decision.reason,
      });
    }

    // Both remaining actions mutate something, so both need the Linear issue:
    // the rerun to report itself, the repair to brief and publish. Without it
    // the safe move is to do nothing and retry — no ledger key is reserved,
    // so nothing is consumed by the wait.
    const issue = await reporter.issue();
    if (!issue?.id || !issue.identifier) {
      return {
        issue: entry.id,
        outcome: "no-linear-issue",
        reason: `could not read the Linear issue for ${entry.id}; automatic repair will retry on a later pass`,
      };
    }

    if (decision.action === "infrastructure-rerun") {
      return await runInfrastructureRerun({ entry, ctx, decision, reporter });
    }

    // Per-pass and host-wide capacity, checked before the reservation so a
    // deferred target is admitted from scratch next cycle rather than being
    // burned as an attempt nobody ran.
    if (passBudget.workersStarted >= passBudget.maxWorkersPerPass) {
      return {
        issue: entry.id,
        outcome: "repair-deferred",
        reason: `this pass has already started its maximum of ${passBudget.maxWorkersPerPass} repair worker(s)`,
        key: decision.key,
      };
    }
    const activeCount = worktreeManager?.activeCount?.() ?? 0;
    if (activeCount >= concurrencyLimit) {
      return {
        issue: entry.id,
        outcome: "repair-deferred",
        reason: `${activeCount} dispatch worker(s) are already active at a concurrency limit of ${concurrencyLimit}`,
        key: decision.key,
      };
    }

    return await runCodeRepair({ entry, issue, ctx, decision, observation, reporter, passBudget });
  } finally {
    await reporter.finish();
  }
}

/**
 * One repair pass over every retained, dispatcher-owned review worktree.
 *
 * Targets are processed sequentially and in a stable order: a repair starts a
 * real worker on a single-flight Mac, so there is nothing to gain from
 * concurrency and a deterministic order makes "which target got the one
 * available slot" reproducible.
 *
 * A failure against one target never aborts the pass — it is logged, reported
 * as its own result, and the next target is still considered.
 *
 * @param {object} ctx - see REQUIRED_DEPENDENCIES plus `enabled`, `ledger`,
 *   `worktreeManager`, `ghRepo`, `logRoot`, `budgets`, `trustedReviewers`,
 *   `workerTimeoutMs`, `concurrencyLimit`, `linearClient`, `stateIds`.
 * @returns {Promise<Array<{issue: string, outcome: string, reason?: string}>>}
 */
export async function runRepairPass(ctx = {}) {
  const {
    enabled = false,
    worktreeManager,
    ledger,
    logger = console,
    maxWorkersPerPass = DEFAULT_MAX_REPAIR_WORKERS_PER_PASS,
  } = ctx;

  // Checked before anything is read, so a dispatcher with automatic repair
  // switched off makes no extra GitHub or Linear call at all. `admitRepair()`
  // refuses on the same flag; this is the cheap half of the same "off means
  // observe, never act" rule.
  if (!enabled) return [];

  if (!worktreeManager || !ledger) {
    throw new Error("runRepairPass requires a worktreeManager and a repair ledger");
  }
  const missing = REQUIRED_DEPENDENCIES.filter((name) => typeof ctx[name] !== "function");
  if (missing.length) {
    throw new Error(`runRepairPass is missing required dependencies: ${missing.join(", ")}`);
  }

  const targets = Object.values(worktreeManager.loadState())
    .filter((entry) => entry.status === "review" && entry.prNumber)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const passBudget = { workersStarted: 0, maxWorkersPerPass };
  const results = [];
  for (const entry of targets) {
    try {
      results.push(await repairOneTarget(entry, ctx, passBudget));
    } catch (error) {
      logger.error(`${entry.id}: automatic repair failed for this target (retrying next pass): ${error.message}`);
      results.push({ issue: entry.id, outcome: "repair-pass-error", reason: error.message });
    }
  }
  return results;
}
