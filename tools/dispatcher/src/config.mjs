// Dispatcher configuration and paths.
//
// All runtime configuration lives outside the repository, under
// ~/.config/moviecal/ (mode 700). Nothing here should ever read a
// credential from the repo itself. See docs/operators/local-execution.md.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { LOCAL_DISPATCHER_DELEGATE } from "./dispatch-eligibility.mjs";
import { DEFAULT_REPAIR_BUDGETS } from "./ci-outcomes.mjs";
import { DEFAULT_MASTER_VERIFICATION_WORKFLOWS } from "./master-ci-policy.mjs";
import { ISSUE_SPEC_MODES, DEFAULT_ISSUE_SPEC_MODE } from "./issue-spec.mjs";

export const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
);

/**
 * `MOVIECAL_CONFIG_DIR` relocates every dispatcher state file. The test lanes
 * and disposable smoke runs point it at a temporary directory so nothing can
 * write the live ledger under `~/.config/moviecal` (MOV-382).
 */
export function configDir() {
  const override = process.env.MOVIECAL_CONFIG_DIR;
  if (override && path.isAbsolute(override)) return override;
  return path.join(os.homedir(), ".config", "moviecal");
}

export function linearEnvPath() {
  return path.join(configDir(), "linear.env");
}

export function linearAppEnvPath() {
  return path.join(configDir(), "linear-app.env");
}

export function envLocalPath() {
  return path.join(configDir(), "env.local");
}

/**
 * MOV-166: the Mac's own record of the two Agent Session receiver secrets.
 * Only `streamCredential` is read by dispatcher code at runtime (it
 * authenticates the Mac's outbound stream connection); `webhookSigningSecret`
 * is kept here purely so rotation has one local place to look -- the receiver
 * (on Vercel) is what actually verifies it, never this process.
 */
export function agentSessionEnvPath() {
  return path.join(configDir(), "agent-session.env");
}

export function worktreesStatePath() {
  return path.join(configDir(), "worktrees.json");
}

export function priorityPropagationStatePath() {
  return path.join(configDir(), "priority-propagation.json");
}

/** MOV-180: persisted state for host-wide failure-signature circuit breakers (circuit-breaker.mjs). */
export function circuitBreakerStatePath() {
  return path.join(configDir(), "circuit-breakers.json");
}

/** MOV-151: persisted per-issue record of dispatch-time provider usage-limit failures (usage-limit.mjs). */
export function usageLimitStatePath() {
  return path.join(configDir(), "usage-limits.json");
}

/** MOV-360: persisted per-worker (quota-pool) dispatch cooldown record (worker-cooldown.mjs). */
export function workerCooldownStatePath() {
  return path.join(configDir(), "worker-cooldowns.json");
}

/** Numeric, redacted summaries of completed worker attempts (MOV-363). */
export function workerUsageStatePath() {
  return path.join(configDir(), "worker-usage.json");
}

/**
 * MOV-188: the durable record of what automatic repair has already tried
 * (repair-ledger.mjs). Not a credential — but it *is* what makes the repair
 * budget bounded across a dispatcher restart, so it lives with the rest of the
 * runtime state outside the repository.
 */
export function repairLedgerStatePath() {
  return path.join(configDir(), "repair-ledger.json");
}

/**
 * MOV-305: the durable record of every observed post-merge `master` failure
 * (master-incident-ledger.mjs). Not a credential — it is what makes the
 * observer idempotent across a daemon restart, so a replayed run updates the
 * original remediation item instead of filing a second one.
 */
export function masterIncidentLedgerStatePath() {
  return path.join(configDir(), "master-incidents.json");
}

/** Durable staged-rollout reservations for MOV-162 PR readiness/merge actions. */
export function prAutonomyLedgerStatePath() {
  return path.join(configDir(), "pr-autonomy-ledger.json");
}

/** Non-secret launchd first-poll status (MOV-287). */
export function dispatcherLaunchHealthStatePath() {
  return path.join(configDir(), "dispatcher-launch-health.json");
}

export function dispatcherLockPath() {
  return path.join(configDir(), "dispatcher.lock");
}

export function worktreeRoot() {
  return process.env.MOVIECAL_WORKTREE_ROOT || path.join(os.homedir(), "code", "worktrees", "moviecal");
}

export function logRoot() {
  return process.env.MOVIECAL_LOG_ROOT || path.join(os.homedir(), "Library", "Logs", "moviecal-dispatcher");
}

// The Mac adapter is deliberately single-flight. Xcode and the self-hosted
// runner contend for the same scarce resources; raise this only when a real
// nonblocking supervisor exists.
export const DEFAULT_CONCURRENCY = 1;
export const RUN_LOG_RETENTION_DAYS = 90;
export const FAILED_WORKTREE_RETENTION_DAYS = 7;
// MOV-138: a worker is one-shot with no resume, so a hang (MOV-106) must be
// killed rather than freeze the poll loop forever. 45 minutes comfortably
// exceeds a healthy `npm run verify` + implementation pass.
export const DEFAULT_WORKER_TIMEOUT_MS = 2_700_000;
// MOV-158: how often to re-read a claimed issue while its worker runs, so a
// de-delegation or cancellation is honoured within a minute instead of after a
// 45-minute worker. One extra `issueSnapshot` per minute per active worker, and
// the Mac adapter runs one worker at a time. Set MOVIECAL_STOP_POLL_MS=0 to
// disable the watcher; the boundary checks around it still run.
export const DEFAULT_STOP_POLL_INTERVAL_MS = 60_000;

/** Parse a simple KEY=VALUE dotenv-style file. Returns {} if the file is missing. */
export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Check a path is present and mode-600 (or stricter). Returns {ok, reason}. */
export function checkSecretFileMode(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `missing: ${filePath}` };
  }
  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode & 0o077) {
    return { ok: false, reason: `${filePath} is mode ${mode.toString(8)}, expected 600 or stricter (group/other must have no access)` };
  }
  return { ok: true, reason: null };
}

export function loadLinearConfig(envPath = linearEnvPath()) {
  const env = parseEnvFile(envPath);
  return {
    apiKey: env.LINEAR_API_KEY || process.env.LINEAR_API_KEY || null,
    teamKey: env.LINEAR_TEAM_KEY || process.env.LINEAR_TEAM_KEY || "MOV",
  };
}

/**
 * The app-actor OAuth credential (MOV-122). Optional during the transition:
 * when `clientId`/`clientSecret` are absent the dispatcher keeps using the
 * personal API key from `loadLinearConfig()`. `scopes` is left null here so
 * the token minter (`getAppToken`) applies its own default.
 */
export function loadLinearAppConfig(envPath = linearAppEnvPath()) {
  const env = parseEnvFile(envPath);
  return {
    clientId: env.LINEAR_APP_CLIENT_ID || process.env.LINEAR_APP_CLIENT_ID || null,
    clientSecret:
      env.LINEAR_APP_CLIENT_SECRET || process.env.LINEAR_APP_CLIENT_SECRET || null,
    actorId: env.LINEAR_APP_ACTOR_ID || process.env.LINEAR_APP_ACTOR_ID || null,
    scopes: env.LINEAR_APP_SCOPES || process.env.LINEAR_APP_SCOPES || null,
  };
}

/**
 * The identity the local dispatcher claims work as (MOV-143). An issue's
 * Linear `delegate` must match this before the Mac adapter will run it — see
 * `dispatch-eligibility.mjs` and docs/operators/local-execution.md §Dispatch
 * trigger. The app-actor id (`linear-app.env`, MOV-122) is authoritative when
 * configured; the name is the fallback for the personal-API-key path, which
 * has no actor id of its own.
 */
export function resolveDispatcherDelegate({ linearAppPath = linearAppEnvPath() } = {}) {
  const { actorId } = loadLinearAppConfig(linearAppPath);
  return { id: actorId || null, name: LOCAL_DISPATCHER_DELEGATE };
}

/**
 * Is the (optional) Linear Agent Session enrichment layer switched on?
 * (MOV-158.)
 *
 * Off unless `MOVIECAL_AGENT_SESSIONS` is explicitly truthy. MOV-159/166
 * supplied the optional signed HTTPS receiver and outbound Mac stream, but
 * off remains a complete supported configuration: polling, states, and
 * comments carry the durable lifecycle. Nothing about this flag adds a Mac
 * listener or changes dispatch authority; with it on and no entitlement, the
 * dispatcher makes one failed mutation, latches the answer, and keeps using
 * comments.
 */
export function agentSessionsEnabled(env = process.env) {
  return truthy(env.MOVIECAL_AGENT_SESSIONS);
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/**
 * MOV-166: the Mac's outbound Agent Session stream endpoint and credential --
 * the only Agent Session secret this process ever reads. The webhook signing
 * secret is a *receiver*-side credential (verified on Vercel, never here); an
 * operator may keep their own reference copy of it in the same file at
 * `agentSessionEnvPath()` for rotation convenience, but this loader
 * deliberately never names or parses that key, so the dispatcher itself
 * stays free of it -- see the structural guard in dispatcher-wiring.test.mjs.
 */
export function loadAgentSessionStreamConfig(envPath = agentSessionEnvPath()) {
  const env = parseEnvFile(envPath);
  return {
    streamUrl: env.AGENT_SESSION_STREAM_URL || process.env.AGENT_SESSION_STREAM_URL || null,
    streamCredential: env.AGENT_SESSION_STREAM_CREDENTIAL || process.env.AGENT_SESSION_STREAM_CREDENTIAL || null,
  };
}

/**
 * MOV-166/MOV-214-215: is live mid-run prompt delivery into the Claude worker
 * switched on? A separate, independent flag from `agentSessionsEnabled()` --
 * steering is materially riskier than the receiver alone (it changes the
 * worker invocation mode), so it gets its own on/off switch, off by default.
 * With this off, the routed worker invocation and `spawnWorker()`'s return
 * shape are byte-identical to today, on every worker and every issue.
 */
export function agentSessionSteeringEnabled(env = process.env) {
  return truthy(env.MOVIECAL_AGENT_SESSION_STEERING);
}

/**
 * Is bounded automatic CI/review repair switched on? (MOV-188.)
 *
 * Off unless `MOVIECAL_AUTO_REPAIR` is explicitly truthy, and off is the
 * shipped default: repair is the one dispatcher behaviour that starts a worker
 * and pushes to an existing PR with nobody watching, so it is opt-in and its
 * first live cycle is supervised by hand (docs/operators/local-execution.md
 * §Automatic CI and review repair). `admitRepair()` refuses everything while
 * this is false, so an unset variable can only ever mean "observe, never act".
 */
export function autoRepairEnabled(env = process.env) {
  return truthy(env.MOVIECAL_AUTO_REPAIR);
}

/**
 * Is the post-merge `master` failure observer switched on? (MOV-305.)
 *
 * Off unless `MOVIECAL_MASTER_CI_OBSERVER` is explicitly truthy, and off is
 * the shipped default for the same reason `MOVIECAL_AUTO_REPAIR` is: this is
 * a pass that files new Linear issues with nobody watching. Unsetting the
 * variable is also how an operator disables it — the observer reads nothing
 * and writes nothing at all while it is false, so disabling it can never
 * leave a half-finished incident behind (an already-filed remediation issue
 * simply stays where it is and is worked by hand).
 */
export function masterCiObserverEnabled(env = process.env) {
  return truthy(env.MOVIECAL_MASTER_CI_OBSERVER);
}

/**
 * Which workflows' `push`-on-`master` runs count as verification (MOV-305).
 * Defaults to the four workflows that can actually produce one; a
 * comma-separated override lets an operator narrow it (e.g. to `verify`
 * alone) during a supervised first cycle. An override that parses to nothing
 * falls back to the default rather than to "every workflow".
 */
export function resolveMasterVerificationWorkflows(env = process.env) {
  const configured = String(env.MOVIECAL_MASTER_CI_WORKFLOWS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return configured.length ? configured : [...DEFAULT_MASTER_VERIFICATION_WORKFLOWS];
}

/**
 * How many master incidents may be routed for an automatic fix PR at once
 * (MOV-305). Counted across open incidents, not per incident: the thing worth
 * bounding is how many unreviewed remediation branches can exist, not how
 * many times one run was looked at. A non-integer or negative value reads as
 * the default rather than as "unbounded".
 */
export const DEFAULT_MASTER_INCIDENT_ROUTE_BUDGET = 1;

export function resolveMasterIncidentRouteBudget(env = process.env) {
  const value = Number(env.MOVIECAL_MASTER_CI_ROUTE_BUDGET);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MASTER_INCIDENT_ROUTE_BUDGET;
}

/**
 * How far behind the `master` tip a failed commit may be and still be treated
 * as current, trusted lineage (MOV-305). Beyond it — or off the lineage
 * entirely — the incident stops for a human, because a fix branched from
 * current `master` would no longer be repairing the code that failed.
 */
export const DEFAULT_MASTER_LINEAGE_MAX_DISTANCE = 10;

export function resolveMasterLineageMaxDistance(env = process.env) {
  const value = Number(env.MOVIECAL_MASTER_CI_MAX_LINEAGE_DISTANCE);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MASTER_LINEAGE_MAX_DISTANCE;
}

/**
 * Where a master-failure remediation issue is filed (MOV-305). It must be an
 * open project, because the issue-completeness contract refuses a completed
 * or canceled one — the observer surfaces that as a failed creation and a
 * human decision rather than filing an unroutable issue.
 */
export const DEFAULT_MASTER_INCIDENT_PROJECT = "Autonomous local-agent delivery";
export const DEFAULT_MASTER_INCIDENT_MILESTONE = "Local acceptance & controlled autonomy";

export function resolveMasterIncidentProject(env = process.env) {
  return {
    projectName: String(env.MOVIECAL_MASTER_CI_PROJECT ?? "").trim() || DEFAULT_MASTER_INCIDENT_PROJECT,
    milestoneName: String(env.MOVIECAL_MASTER_CI_MILESTONE ?? "").trim() || DEFAULT_MASTER_INCIDENT_MILESTONE,
  };
}

/**
 * How strictly the issue-completeness contract is applied (MOV-303).
 *
 * `off` ignores it entirely; `report` (the default) promotes exactly as
 * before and only logs/comments what is missing; `enforce` additionally
 * refuses to promote an incomplete issue. It ships as `report` deliberately:
 * turning this on at merge time would strand every backlog issue filed before
 * the contract existed, so the owner switches to `enforce` only after the
 * backlog is backfilled. An unrecognized value reads as `report` rather than
 * as `enforce`, so a typo can never silently stall the queue.
 */
export function resolveIssueSpecMode(env = process.env) {
  const raw = String(env.MOVIECAL_ISSUE_SPEC_MODE ?? "").trim().toLowerCase();
  return ISSUE_SPEC_MODES.includes(raw) ? raw : DEFAULT_ISSUE_SPEC_MODE;
}

/**
 * The workspace member the promoter assigns to an eligible issue that has no
 * assignee, before it moves into Ready for Agent (MOV-359). Linear refuses to
 * delegate an unowned issue to `moviecal-dispatcher`
 * ("moviecal-dispatcher works on behalf of a person. Assign a workspace
 * member to the issue first, then delegate."), so an issue an authoring
 * agent or human left unassigned would otherwise reach Ready for Agent and
 * then stall at the handoff Loop.
 *
 * Unset by default: an unassigned issue then fails closed
 * (`owner-assignment.mjs`) rather than falling back to a hardcoded person, so
 * a workspace change (the owner leaving, a new default) is a one-line config
 * edit here, never a code change. The initial operator value is Adam Moore's
 * workspace email, set in this Mac's own environment — never committed to
 * the repo.
 */
export function resolveDefaultOwnerEmail(env = process.env) {
  return String(env.MOVIECAL_DEFAULT_OWNER_EMAIL ?? "").trim() || null;
}

/**
 * How often the in-loop issue-completeness audit (issue-spec-audit.mjs) may
 * run automatically, in milliseconds. It does not run every 30-second poll
 * cycle -- only once this many milliseconds have elapsed since the last
 * *completed* run, persisted at `issueSpecAuditStatePath()` so a daemon
 * restart does not trigger an immediate re-scan. Defaults to 24 hours;
 * zero, negative, or non-numeric values fall back to the default rather than
 * disabling the interval (`MOVIECAL_ISSUE_SPEC_MODE=off` is the switch for
 * disabling the audit entirely). `dispatcher audit-issues` (the standalone
 * command) is never gated by this -- only the automatic in-loop call is.
 */
export const DEFAULT_ISSUE_SPEC_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function resolveIssueSpecAuditIntervalMs(env = process.env) {
  const raw = Number(env.MOVIECAL_ISSUE_SPEC_AUDIT_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ISSUE_SPEC_AUDIT_INTERVAL_MS;
}

/** Persisted `{ lastRunAt }` for the in-loop issue-spec audit's cadence (MOV-303). */
export function issueSpecAuditStatePath() {
  return path.join(configDir(), "issue-spec-audit-state.json");
}

/** Off unless explicitly enabled; removing this switch immediately restores manual PR control. */
export function prAutonomyEnabled(env = process.env) {
  return truthy(env.MOVIECAL_PR_AUTONOMY);
}

/** A malformed rollout cap never widens automation; the default is zero actions. */
export function resolvePrAutonomyMaxActions(env = process.env) {
  const value = Number(env.MOVIECAL_PR_AUTONOMY_MAX_ACTIONS);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The GitHub logins whose `REQUEST_CHANGES` review may start a repair
 * (MOV-188). Empty by default and deliberately so: a `REQUEST_CHANGES` is an
 * instruction to change code, which is exactly what prompt injection would
 * most like to reach, so it is honoured only from a login an operator named
 * here. With none configured, every `REQUEST_CHANGES` escalates instead.
 */
export function resolveTrustedReviewers(env = process.env) {
  return String(env.MOVIECAL_TRUSTED_REVIEWERS ?? "")
    .split(",")
    .map((login) => login.trim())
    .filter(Boolean);
}

/**
 * The per-PR repair attempt budget (MOV-188), overridable per-field so an
 * operator can tighten it for a supervised cycle without editing code. A
 * non-numeric or negative override is ignored rather than silently widening
 * the budget it was meant to bound.
 */
export function resolveRepairBudgets(env = process.env) {
  const bounded = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    codeRepair: bounded(env.MOVIECAL_REPAIR_BUDGET_CODE, DEFAULT_REPAIR_BUDGETS.codeRepair),
    infrastructureRerun: bounded(env.MOVIECAL_REPAIR_BUDGET_INFRA, DEFAULT_REPAIR_BUDGETS.infrastructureRerun),
    total: bounded(env.MOVIECAL_REPAIR_BUDGET_TOTAL, DEFAULT_REPAIR_BUDGETS.total),
  };
}

/**
 * Resolve which Linear credential the dispatcher's real run/dry-run path
 * should authenticate with: `linear-app.env` (MOV-122 app actor) when both
 * halves of the client-credentials pair are present, else the personal
 * `linear.env` API key (today's behaviour, unconditionally reversible by
 * removing linear-app.env). `mode: "none"` means neither is configured.
 */
export function resolveLinearAuth({ linearPath = linearEnvPath(), linearAppPath = linearAppEnvPath() } = {}) {
  const { apiKey, teamKey } = loadLinearConfig(linearPath);
  const appConfig = loadLinearAppConfig(linearAppPath);
  if (appConfig.clientId && appConfig.clientSecret) {
    return {
      mode: "app",
      teamKey,
      appAuth: {
        clientId: appConfig.clientId,
        clientSecret: appConfig.clientSecret,
        scopes: appConfig.scopes || undefined,
      },
    };
  }
  if (apiKey) {
    return { mode: "apiKey", teamKey, apiKey };
  }
  return { mode: "none", teamKey };
}
