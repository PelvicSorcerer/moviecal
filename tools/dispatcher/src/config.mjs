// Dispatcher configuration and paths.
//
// All runtime configuration lives outside the repository, under
// ~/.config/moviecal/ (mode 700). Nothing here should ever read a
// credential from the repo itself. See docs/operators/local-execution.md.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { LOCAL_DISPATCHER_DELEGATE } from "./dispatch-eligibility.mjs";

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

export function worktreeRoot() {
  return process.env.MOVIECAL_WORKTREE_ROOT || path.join(os.homedir(), "code", "worktrees", "moviecal");
}

export function logRoot() {
  return process.env.MOVIECAL_LOG_ROOT || path.join(os.homedir(), "Library", "Logs", "moviecal-dispatcher");
}

export const DEFAULT_CONCURRENCY = 2;
export const RUN_LOG_RETENTION_DAYS = 90;
export const FAILED_WORKTREE_RETENTION_DAYS = 7;
// MOV-138: a worker is one-shot with no resume, so a hang (MOV-106) must be
// killed rather than freeze the poll loop forever. 45 minutes comfortably
// exceeds a healthy `npm run verify` + implementation pass.
export const DEFAULT_WORKER_TIMEOUT_MS = 2_700_000;

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
