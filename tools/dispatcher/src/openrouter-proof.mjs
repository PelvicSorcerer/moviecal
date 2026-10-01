// Human-led, one-shot MOV-429 proof. Never used by dispatcher activation.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { OPENROUTER_MODEL, OPENROUTER_UPSTREAM } from "./openrouter-transport.mjs";
import { prepareCodexContainment } from "./codex-containment.mjs";
import { workerInvocation } from "./worker-routing.mjs";
import { spawnWorker } from "./worker-spawn.mjs";
import { captureVerificationEvidence } from "./readiness-evidence.mjs";
import { readRoutedRequestEvidence, summarizeRoutedInvoice } from "./routed-request.mjs";

/** Identity only: never use the public catalogue's prices/default effort. */
export function modelAliasesFromCatalog(catalog) {
  if (!Array.isArray(catalog?.data) || !catalog.data.length || catalog.data.length > 5000) throw new Error("invalid model catalogue");
  const aliases = Object.create(null);
  for (const model of catalog.data) {
    if (![model?.id, model?.canonical_slug].every((value) => typeof value === "string"
      && /^~?[A-Za-z0-9_.:/-]{1,200}$/.test(value))) throw new Error("invalid model catalogue identity");
    if (Object.hasOwn(aliases, model.id) && aliases[model.id] !== model.canonical_slug) throw new Error("conflicting model catalogue identity");
    aliases[model.id] = model.canonical_slug;
  }
  return aliases;
}

/** Read only an owner attestation; never the provider credential. */
export function readProofApproval({ home = os.homedir(), now = new Date() } = {}) {
  const filename = path.join(home, ".config/moviecal/jev-proof-approval.json");
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o777) !== 0o600 || stat.size > 4096
    || fs.realpathSync(filename) !== filename) throw new Error("proof approval file must be external, owner-owned mode 600 and unlinked");
  const approval = JSON.parse(fs.readFileSync(filename, "utf8"));
  const reviewed = Date.parse(approval.reviewedAt), expires = Date.parse(approval.expiresAt);
  if (approval.issue !== "MOV-429" || approval.owner !== "Adam Moore" || approval.ownerApproved !== true
    || approval.securityReviewPassed !== true || approval.effectiveEligibilityUnrestricted !== true
    || approval.promptLoggingOff !== true || approval.zdrOff !== true || approval.dataCollectionUnrestricted !== true
    || approval.keyLimitUsd !== 69 || approval.allInCeilingUsd !== 75
    || ![approval.availableCreditUsd, approval.keyRemainingUsd, approval.allInOutlayUsd].every((value) => typeof value === "number" && Number.isFinite(value))
    || !(approval.availableCreditUsd > 0) || !(approval.keyRemainingUsd > 0 && approval.keyRemainingUsd <= 69)
    || !(approval.allInOutlayUsd >= 0 && approval.allInOutlayUsd <= 75)
    || !Number.isFinite(reviewed) || !Number.isFinite(expires) || reviewed > now.getTime()
    || expires <= now.getTime() || expires - reviewed > 3600000 || expires <= reviewed
    || !Number.isInteger(approval.maxRequests) || approval.maxRequests < 1 || approval.maxRequests > 6
    || !/^[A-Za-z0-9_-]{3,80}$/.test(approval.keyId || "") || !/^[A-Za-z0-9_-]{3,80}$/.test(approval.workspaceId || "")) {
    throw new Error("proof requires current owner security/key/credit approval; no provider request sent");
  }
  return { approval, filename };
}

export async function runDisposableProof() {
  const { approval, filename } = readProofApproval();
  // Anonymous read-only preflight, before guarded processes or paid traffic.
  // Keep the public id -> canonical_slug snapshot with the evidence; the
  // broker has no additional network destination and never guesses aliases.
  const catalogResponse = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!catalogResponse.ok) throw new Error("model catalogue unavailable");
  const catalogText = await catalogResponse.text();
  if (catalogText.length > 8 * 1024 * 1024) throw new Error("model catalogue too large");
  const modelAliases = modelAliasesFromCatalog(JSON.parse(catalogText));
  // Exclusive owner-store fuse. Repeating the command cannot silently buy
  // another proof; a new reviewed approval must explicitly remove this fuse.
  fs.writeFileSync(`${filename}.used`, JSON.stringify({ consumedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mov429-proof-")));
  const cwd = path.join(root, "repo"), logDir = path.join(root, "evidence");
  fs.mkdirSync(cwd); fs.mkdirSync(logDir);
  fs.writeFileSync(path.join(logDir, "openrouter-model-aliases.json"), JSON.stringify(modelAliases), { mode: 0o600 });
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { verify: "node verify.cjs" } }));
  fs.writeFileSync(path.join(cwd, "answer.txt"), "before\n");
  fs.writeFileSync(path.join(cwd, "verify.cjs"), "require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8'),'after\\n');\n");
  const policy = { model: OPENROUTER_MODEL, providers: [], zdr: false, dataCollection: null,
    promptLogging: false, keyLimitUsd: 69, spendCeilingUsd: 75, keyId: approval.keyId,
    workspaceId: approval.workspaceId, ownerReviewed: true };
  policy.hash = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const transport = { enabled: true, policy, upstream: OPENROUTER_UPSTREAM,
    credentialPath: path.join(os.homedir(), ".config/moviecal/openrouter-jev.env") };
  const invocation = workerInvocation("codex", "cheap");
  invocation.args.push("--skip-git-repo-check");
  const result = await spawnWorker({ invocation, cwd, logDir, issueIdentifier: "MOV-429",
    brief: "Disposable proof: read answer.txt with a tool, edit it from before to after with a file editing tool, then run the exact command npm run verify. Report the result. Do not delegate, access the network or inspect credentials. Stop after verification.",
    securityContext: { mode: "implementation" }, signal: AbortSignal.timeout(180000),
    jev: { armId: "jev-hosted", policyHash: policy.hash, worker: "codex" }, providerTransport: transport,
    prepareCodexContainmentFn: (args) => prepareCodexContainment({ ...args,
      approvedOpenRouterPolicyHashes: [policy.hash], providerRequestLimit: approval.maxRequests, openRouterModelAliases: modelAliases }),
  });
  const records = readRoutedRequestEvidence(logDir);
  const verification = captureVerificationEvidence(logDir);
  const transcript = fs.readFileSync(path.join(logDir, "stdout.log"), "utf8").split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const editedWithTool = transcript.some((event) => event.type === "item.completed" && event.item?.type === "file_change"
    && event.item.status === "completed");
  const nonAnthropic = records.some((record, index) => record.resolvedModel && !record.resolvedModel.startsWith("anthropic/")
    && record.toolCalls > 0 && records[index + 1]?.toolOutputs > 0 && !record.error && !records[index + 1].error);
  const proof = { issue: "MOV-429", date: new Date().toISOString(), logDir, exitCode: result.exitCode,
    verification: verification.status, nonAnthropic, editedWithTool, routedInvoice: summarizeRoutedInvoice(records),
    records, attribution: fs.existsSync(path.join(logDir, "openrouter-attribution.jsonl"))
      ? fs.readFileSync(path.join(logDir, "openrouter-attribution.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [],
    outcome: result.exitCode === 0 && verification.status === "passed" && nonAnthropic && editedWithTool
      && records.length >= 2 && records.every((record) => !record.error) ? "go" : "no-go",
    cohortEnabled: false };
  fs.writeFileSync(path.join(logDir, "proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runDisposableProof(), null, 2)); }
  catch (error) { console.error(`MOV-429 proof stopped: ${error.code === "EEXIST" ? "approval already consumed" : "approval/setup incomplete"}`); process.exitCode = 1; }
}
