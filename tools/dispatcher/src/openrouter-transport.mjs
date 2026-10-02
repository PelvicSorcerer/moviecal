// MOV-425: disabled-by-default, trusted Codex provider transport. No live
// caller supplies this configuration until MOV-429 and MOV-431 approve it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JevCohortStore, policyDigest } from "./jev-cohort.mjs";

export const OPENROUTER_MODEL = "typesafe/jev-router";
export const OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1/responses";
export const APPROVED_OPENROUTER_POLICY_HASHES = Object.freeze([]);

/** Dedicated needs-secrets gate; inspect file metadata only, never its value. */
export function requiredSecretPresent(name, { home = os.homedir(), envLocalPath } = {}) {
  if (name !== "openrouter-jev") return Boolean(envLocalPath && fs.existsSync(envLocalPath));
  try {
    const store = path.join(home, ".config", "moviecal");
    const file = path.join(store, "openrouter-jev.env");
    const stat = fs.lstatSync(file);
    return !fs.lstatSync(path.join(home, ".config")).isSymbolicLink()
      && !fs.lstatSync(store).isSymbolicLink() && stat.isFile() && !stat.isSymbolicLink()
      && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid()
      && stat.size >= 8 && stat.size <= 256;
  } catch { return false; }
}

export function buildOpenRouterRequest(body, policy) {
  if (!policy || !body || typeof body !== "object" || Array.isArray(body)
    || body.model !== policy?.model
    || (policy.model !== OPENROUTER_MODEL && (policy.side !== "control"
      || body.reasoning?.effort !== policy.effort))
    || ["provider", "models", "route", "plugins", "debug"].some((field) => Object.hasOwn(body, field))
    || !Array.isArray(policy.providers) || policy.providers.length !== 0
    || policy.zdr !== false || policy.dataCollection !== null) {
    throw new Error("OpenRouter request violates policy");
  }
  // MOV-424 approved unrestricted downstream routing. An absent provider
  // object lets Jev select compatible providers without request-level filters.
  return { ...body };
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Validates metadata and file ownership without ever opening the key. */
export function validateOpenRouterTransport(transport, { cwd, home = os.homedir(), fixture = false,
  approvedPolicyHashes = APPROVED_OPENROUTER_POLICY_HASHES, cohortAdmissionPreview = false } = {}) {
  if (!transport || transport.enabled !== true || !path.isAbsolute(cwd || "")) throw new Error("OpenRouter transport disabled or missing worktree");
  const { policy, credentialPath, upstream } = transport;
  let cohortPolicy = null;
  if (transport.cohort) {
    const store = new JevCohortStore({ ...transport.cohort, home });
    cohortPolicy = store.policy();
    const assignment = store.get(transport.cohort.issue);
    const preselectedSide = cohortPolicy?.pairs?.some((pair) => pair[transport.cohort.side] === transport.cohort.issue);
    if (!cohortPolicy || (!assignment && !(cohortAdmissionPreview && preselectedSide))
      || !preselectedSide || (assignment && (assignment.policyHash !== policyDigest(cohortPolicy)
        || assignment.issue !== transport.cohort.issue || assignment.side !== transport.cohort.side
        || assignment.worker !== "codex" || assignment.tier !== cohortPolicy.control.tier
        || (assignment.side === "control" && assignment.effort !== cohortPolicy.control.effort)))
      || store.state().status !== "active") {
      throw new Error("OpenRouter cohort approval or assignment changed");
    }
  }
  if (!policy || typeof policy !== "object" || ![OPENROUTER_MODEL, cohortPolicy?.control?.model].includes(policy.model)
    || typeof policy.hash !== "string" || !/^[a-f0-9]{64}$/.test(policy.hash)
    || (!fixture && !cohortPolicy && !approvedPolicyHashes.includes(policy.hash))
    || (cohortPolicy && (policy.hash !== policyDigest(cohortPolicy)
      || policy.model !== (transport.cohort.side === "control" ? cohortPolicy.control.model : OPENROUTER_MODEL)
      || policy.side !== transport.cohort.side
      || (policy.side === "control" && (policy.provider !== cohortPolicy.control.provider || policy.effort !== cohortPolicy.control.effort))
      || policy.keyId !== cohortPolicy.keyId || policy.workspaceId !== cohortPolicy.workspaceId))
    || !Array.isArray(policy.providers) || policy.providers.length !== 0
    || policy.zdr !== false || policy.dataCollection !== null || policy.promptLogging !== false
    || policy.keyLimitUsd !== 69 || policy.spendCeilingUsd !== 75
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
    || path.basename(credentialPath) !== "openrouter-jev.env" || contained(cwd, credentialPath)) {
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
    hash: policy.hash, model: policy.model, providers: [],
    ...(cohortPolicy ? { side: policy.side, provider: policy.provider || null, effort: policy.effort || null,
      keyId: policy.keyId, workspaceId: policy.workspaceId } : {}),
    zdr: false, dataCollection: null, promptLogging: false,
    keyLimitUsd: 69, spendCeilingUsd: 75,
  }, ...(cohortPolicy ? { cohort: transport.cohort, modelAliases: cohortPolicy.modelAliases } : {}) };
}
