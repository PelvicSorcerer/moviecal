// MOV-425: disabled-by-default, trusted Codex provider transport. No live
// caller supplies this configuration until MOV-429 and MOV-431 approve it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENROUTER_MODEL = "typesafe/jev-router";
export const OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1/responses";
export const APPROVED_OPENROUTER_POLICY_HASHES = Object.freeze([]);

/** Dedicated needs-secrets gate; inspect file metadata only, never its value. */
export function requiredSecretPresent(name, { home = os.homedir(), envLocalPath } = {}) {
  if (name !== "openrouter-jev") return Boolean(envLocalPath && fs.existsSync(envLocalPath));
  try {
    const store = path.join(home, ".config", "moviecal");
    const file = path.join(store, "openrouter-jev.key");
    const stat = fs.lstatSync(file);
    return !fs.lstatSync(path.join(home, ".config")).isSymbolicLink()
      && !fs.lstatSync(store).isSymbolicLink() && stat.isFile() && !stat.isSymbolicLink()
      && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid()
      && stat.size >= 8 && stat.size <= 256;
  } catch { return false; }
}

export function buildOpenRouterRequest(body, policy) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || body.model !== OPENROUTER_MODEL || policy?.model !== OPENROUTER_MODEL
    || Object.hasOwn(body, "provider") || !Array.isArray(policy.providers) || policy.providers.length === 0
    || policy.zdr !== true || policy.dataCollection !== "deny") {
    throw new Error("OpenRouter request violates policy");
  }
  return { ...body, provider: { order: [...policy.providers], allow_fallbacks: false,
    data_collection: "deny", zdr: true } };
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Validates metadata and file ownership without ever opening the key. */
export function validateOpenRouterTransport(transport, { cwd, home = os.homedir(), fixture = false } = {}) {
  if (!transport || transport.enabled !== true || !path.isAbsolute(cwd || "")) throw new Error("OpenRouter transport disabled or missing worktree");
  const { policy, credentialPath, upstream } = transport;
  if (!policy || typeof policy !== "object" || policy.model !== OPENROUTER_MODEL
    || typeof policy.hash !== "string" || !/^[a-f0-9]{64}$/.test(policy.hash)
    || (!fixture && !APPROVED_OPENROUTER_POLICY_HASHES.includes(policy.hash))
    || !Array.isArray(policy.providers) || policy.providers.length === 0
    || policy.providers.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_-]{2,64}$/.test(value))
    || policy.zdr !== true || policy.dataCollection !== "deny" || policy.promptLogging !== false
    || policy.keyLimitUsd !== 75 || policy.spendCeilingUsd !== 75
    || typeof policy.keyId !== "string" || !/^[A-Za-z0-9_-]{3,80}$/.test(policy.keyId)
    || typeof policy.workspaceId !== "string" || !/^[A-Za-z0-9_-]{3,80}$/.test(policy.workspaceId)
    || policy.ownerReviewed !== true) {
    throw new Error("OpenRouter policy is missing, unapproved, or invalid");
  }
  if (fixture) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/v1\/responses$/.test(upstream || "")) throw new Error("OpenRouter fixture endpoint is invalid");
  } else if (upstream !== OPENROUTER_UPSTREAM) throw new Error("OpenRouter endpoint is not allowlisted");
  const approvedCredentialRoot = path.resolve(home, ".config", "moviecal");
  if (!path.isAbsolute(credentialPath || "") || !contained(approvedCredentialRoot, credentialPath)
    || path.basename(credentialPath) !== "openrouter-jev.key" || contained(cwd, credentialPath)) {
    throw new Error("OpenRouter credential must be in the dedicated external store");
  }
  let stat;
  try { stat = fs.lstatSync(credentialPath); } catch { throw new Error("OpenRouter credential is unavailable"); }
  if (fs.lstatSync(path.join(home, ".config")).isSymbolicLink()
    || fs.lstatSync(approvedCredentialRoot).isSymbolicLink()) {
    throw new Error("OpenRouter credential store must not be linked");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size < 8 || stat.size > 256) {
    throw new Error("OpenRouter credential ownership or permissions are invalid");
  }
  return { credentialPath, upstream, policy: {
    hash: policy.hash, model: policy.model, providers: [...new Set(policy.providers)],
    zdr: true, dataCollection: "deny", promptLogging: false,
    keyLimitUsd: 75, spendCeilingUsd: 75,
  } };
}
