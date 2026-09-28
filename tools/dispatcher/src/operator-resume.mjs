// Read-only admission for one operator-authorized continuation. All facts are
// collected again under the dispatcher lock immediately before the claim.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateLocalDispatch } from "./dispatch-eligibility.mjs";
import { buildIsIssueSatisfied } from "./dependency-gate.mjs";
import { evaluatePreflight } from "./preflight.mjs";
import { resolveDispatchWorker, workerInvocation } from "./worker-routing.mjs";
import { budgetForWorker } from "./turn-budget.mjs";
import { admitBudgetContinuation } from "./usage-limit-resume.mjs";
import { findAnyPrForBranch } from "./pr-check.mjs";
import { DISPATCH_BREAKERS } from "./run-loop.mjs";
import { readWorkerProgress } from "./turn-budget.mjs";
import { redactWorkerOutput } from "./worker-spawn.mjs";

export function parseResumeArgs(args) {
  if (args.length < 1 || args.length > 2 || !/^MOV-[1-9]\d*$/.test(args[0]) ||
      (args.length === 2 && args[1] !== "--dry-run")) {
    throw new Error("usage: dispatcher resume <MOV-N> [--dry-run]");
  }
  return { issueId: args[0], dryRun: args[1] === "--dry-run" };
}

const RECOVERABLE_FAILURE = [
  /Worker safety boundary blocked publication/i,
  /Worker timed out/i,
  /Dispatcher refused or failed to publish the audited worker result/i,
  /Turn budget exhausted/i,
  /Worker exited with code/i,
  /Provider usage limit followed unpublished work/i,
  /worker spawn failed/i,
];
const SUBSTANTIVE_HOLD = /\bRLS\b|row.level security|security decision|policy decision|product decision|requires human (?:input|approval|decision)|human approval/i;

function bounded(value, length = 1200) {
  return redactWorkerOutput(String(value ?? "").slice(0, length)).replace(/```/g, "''' ");
}

function priorEvidence(logDir) {
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(path.join(logDir, file), "utf8")); } catch { return null; }
  };
  const manifest = read("manifest.json");
  const verification = read("verification-evidence.json");
  const audit = read("security-audit.json");
  return {
    logDir,
    originalAttempt: manifest ? {
      worker: manifest.worker || manifest.command || null,
      startedAt: manifest.startedAt || null,
      exitCode: manifest.exitCode ?? null,
    } : null,
    verification: verification ? { status: verification.status || null, reason: bounded(verification.reason, 300) } : null,
    audit: audit ? { ok: audit.ok === true, violations: Array.isArray(audit.violations) ? audit.violations.length : null } : null,
  };
}

function latestPriorLogDir(base) {
  const candidates = [base, path.join(base, "budget-continuation")];
  return candidates.map((directory) => {
    try { return { directory, mtime: fs.statSync(path.join(directory, "manifest.json")).mtimeMs }; }
    catch { return { directory, mtime: -1 }; }
  }).sort((a, b) => b.mtime - a.mtime)[0].directory;
}

/** This function reads Git, GitHub, registry, and Linear snapshots; it writes nothing. */
export function inspectOperatorResume(issue, ctx, { findPrFn = findAnyPrForBranch, gitRunner = execFileSync,
  pathIsRealFn = (candidate) => fs.lstatSync(candidate).isDirectory(),
  processAliveFn = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } } } = {}) {
  const reasons = [];
  const entry = ctx.worktreeManager.loadState()[issue.identifier] || null;
  const branch = entry?.branch || null;
  const worktreePath = entry?.path || null;
  const route = evaluateLocalDispatch(issue, { expectedDelegate: ctx.dispatcherDelegate });
  if (!route.eligible) reasons.push(route.reason || "local route or delegation is invalid");
  if (issue.stateName !== "Needs Human Decision") reasons.push(`issue state is ${issue.stateName || "unknown"}; expected Needs Human Decision`);
  if (issue.labels?.includes("human-only")) reasons.push("human-only issues cannot be resumed");
  if (!entry) reasons.push("no retained dispatcher worktree registry entry exists");
  if (entry && (!entry.linearIssueId || entry.linearIssueId !== issue.id || entry.linearUrl !== issue.url)) reasons.push("retained issue UUID or URL provenance does not match Linear");
  if (entry?.worker !== "claude" && entry?.worker !== "codex") reasons.push("the recorded worker binding is missing or unknown");
  if (entry?.operatorResume) reasons.push(`operator continuation already claimed (${entry.operatorResume.attemptId || "unknown attempt"}); inspect its outcome before any further recovery`);
  if (entry?.workerSpawnPending) reasons.push("a worker spawn is pending or its outcome is unknown");
  const workerAlive = Boolean(entry?.workerPid && processAliveFn(entry.workerPid));
  if (workerAlive) reasons.push("a live or orphan worker PID remains recorded");
  if (entry?.prNumber || entry?.prUrl) reasons.push("registry already records a PR; use the existing PR repair policy");
  if (entry && (entry.path !== path.join(ctx.worktreeRoot, entry.name || "") || !new RegExp(`^${issue.identifier}-[a-z0-9-]+$`).test(entry.name || ""))) {
    reasons.push("retained path is outside the exact dispatcher-owned issue worktree slot");
  }
  if (worktreePath) {
    try { if (!pathIsRealFn(worktreePath)) reasons.push("retained worktree path is not a real directory"); }
    catch { reasons.push("retained worktree path is missing or unreadable"); }
  }

  let changedPaths = [];
  let unpublishedCommits = null;
  let diff = null;
  if (entry) {
    const identity = admitBudgetContinuation({
      issueId: issue.identifier, entry, repository: ctx.ghRepo, branch, worktreePath,
      dispatcherOwned: ctx.worktreeManager.ownershipMarker?.(worktreePath)?.id === issue.identifier,
      integrity: ctx.worktreeManager.worktreeIntegrity(worktreePath, branch),
    });
    reasons.push(...identity.reasons);
    if (!ctx.worktreeManager.isIntactLinkedWorktree(worktreePath)) reasons.push("retained path is not an intact linked Git worktree");
    if (ctx.worktreeManager.worktreeBelongsToRepository?.(worktreePath) !== true) {
      reasons.push("retained worktree Git common directory does not match this dispatcher repository");
    }
    if (!/^agent\/MOV-[1-9]\d*-[a-z0-9-]+$/.test(branch || "")) reasons.push("recorded branch does not have the exact agent/<issue-id>-* form");
    if (entry.status === "failed" && !entry.workerSpawnPending && !workerAlive) {
      try {
        const status = String(gitRunner("git", ["--no-optional-locks", "status", "--porcelain=v1", "-uall"], { cwd: worktreePath, encoding: "utf8" }));
        changedPaths = status.split("\n").filter(Boolean).map((line) => line.slice(3)).slice(0, 100);
      }
      catch { reasons.push("live changed paths could not be read"); }
      try {
        unpublishedCommits = Number(String(gitRunner("git", ["rev-list", "--count", "origin/master..HEAD"], { cwd: worktreePath, encoding: "utf8" })).trim());
        if (!Number.isSafeInteger(unpublishedCommits)) throw new Error("invalid count");
      } catch { reasons.push("unpublished commit count could not be read"); }
      try {
        diff = redactWorkerOutput(String(gitRunner("git", ["--no-optional-locks", "diff", "--stat", "origin/master"],
          { cwd: worktreePath, encoding: "utf8" })).slice(0, 3000)).replace(/```/g, "''' ");
      } catch { reasons.push("live diff summary could not be read"); }
      try {
        if (findPrFn(branch, ctx.ghRepo)) reasons.push("branch already has a PR; use the existing PR repair policy");
      } catch { reasons.push("existing PR status could not be proven"); }
    }
  }
  if (changedPaths.length === 0 && !(unpublishedCommits > 0)) reasons.push("retained tree has no proven unpublished work");

  const lastComment = [...(issue.recentComments || [])].reverse().find((body) => String(body).trim()) || "";
  if (SUBSTANTIVE_HOLD.test(lastComment) || !RECOVERABLE_FAILURE.some((pattern) => pattern.test(lastComment))) {
    reasons.push("the latest Linear comment does not identify a recoverable dispatcher failure; resolve the substantive human decision first");
  }
  const isIssueSatisfied = buildIsIssueSatisfied([issue]);
  const unresolvedBlockers = (issue.blockedByIds || []).filter((blockerId) => !isIssueSatisfied(blockerId));
  const preflight = evaluatePreflight(issue, {
    isIssueSatisfied,
    iosRunnerOnline: ctx.iosRunnerOnline,
    activeWorktreeCount: ctx.worktreeManager.activeCount(),
    concurrencyLimit: ctx.concurrencyLimit,
    secretPresent: ctx.secretPresent,
    worktreePathFree: () => true,
    candidateWorktreePath: worktreePath,
    issueSpecMode: ctx.issueSpecMode,
  });
  if (!preflight.ok) reasons.push(preflight.reason);

  const routing = resolveDispatchWorker(issue, { boundWorker: entry?.worker });
  if (!routing.ok) reasons.push(routing.reason);
  if (entry?.worker && routing.worker !== entry.worker) reasons.push(`current explicit worker route ${routing.worker || "none"} conflicts with recorded ${entry.worker} binding`);
  if (entry?.model && routing.model !== entry.model) reasons.push(`current model tier ${routing.model} differs from recorded ${entry.model}`);
  let invocation = null;
  let turnBudget = null;
  if (routing.ok && routing.worker === entry?.worker) {
    try {
      invocation = workerInvocation(routing.worker, routing.model, { steering: ctx.steeringEnabled && routing.worker === "claude" });
      turnBudget = budgetForWorker(routing.worker, routing.model);
    } catch (error) { reasons.push(`worker invocation unavailable: ${error.message}`); }
  }
  const cooldown = entry?.worker ? ctx.workerCooldownStore.state(entry.worker) : null;
  if (cooldown?.cooling) reasons.push(`recorded worker ${entry.worker} is in provider cooldown until ${cooldown.resetAt}`);
  if (ctx.usageLimitStore?.deferral(issue.identifier)?.deferred || ctx.usageLimitStore?.resumption?.(issue.identifier)) {
    reasons.push("an automatic usage-limit retry or retained resume is already scheduled");
  }
  for (const name of DISPATCH_BREAKERS) {
    const status = ctx.circuitBreaker.status(name);
    if (status.open) reasons.push(`dispatch breaker ${name} is open`);
  }
  const logDir = entry?.name ? latestPriorLogDir(path.join(ctx.logRoot, entry.name)) : null;
  const evidence = logDir ? priorEvidence(logDir) : null;
  return {
    issue: issue.identifier, state: issue.stateName, readOnly: true, admitted: reasons.length === 0, reasons,
    retained: entry ? { branch, path: worktreePath, status: entry.status, worker: entry.worker, model: entry.model, endedAt: entry.endedAt || null } : null,
    changedPaths, unpublishedCommits, routing: { worker: routing.worker, model: routing.model, reason: routing.reason || null },
    prior: { failure: bounded(lastComment, 600), progress: worktreePath ? readWorkerProgress(worktreePath) : null,
      diff, ...evidence },
    prerequisites: { unresolvedBlockers, preflight: preflight.reason, cooldown, turnBudget },
    invocation,
  };
}
