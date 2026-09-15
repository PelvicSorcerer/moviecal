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

export const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
);

export function configDir() {
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

/**
 * MOV-188: the durable record of what automatic repair has already tried
 * (repair-ledger.mjs). Not a credential — but it *is* what makes the repair
 * budget bounded across a dispatcher restart, so it lives with the rest of the
 * runtime state outside the repository.
 */
export function repairLedgerStatePath() {
  return path.join(configDir(), "repair-ledger.json");
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
 * Off unless `MOVIECAL_AGENT_SESSIONS` is explicitly truthy, and off is the
 * correct setting today: MOV-141 found Agent Sessions **disabled** for the
 * `moviecal-dispatcher` app, and enabling them needs an approved HTTPS event
 * receiver that does not exist (MOV-159 decides whether to build one; MOV-166
 * owns live enablement). Nothing about this flag adds a listener, a secret, or
 * a plan change — with it on and no entitlement, the dispatcher makes one
 * failed mutation, latches the answer, and keeps using comments.
 */
export function agentSessionsEnabled(env = process.env) {
  return truthy(env.MOVIECAL_AGENT_SESSIONS);
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
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
