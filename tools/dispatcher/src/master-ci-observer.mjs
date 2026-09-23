// The effectful, post-merge master failure observer (MOV-316).
// It only reads GitHub and mutates Linear plus the incident ledger: a fix is
// always an ordinary remediation issue, never an action against master.

import {
  attributeMasterRun, canCompleteMasterIncident, classifyMasterFailure, decideMasterIncident,
  evaluateMasterLineage, masterIncidentKey, masterRunEligibility, normalizeMasterRun,
} from "./master-ci-policy.mjs";
import {
  masterIncidentHumanDecisionComment, masterIncidentIssueBody, masterIncidentLabels,
  masterIncidentReconciledComment, masterIncidentRoutedComment, masterIncidentSourceComment, masterIncidentTitle,
} from "./master-incident-issue.mjs";

const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);

async function createRemediationIssue({ linearClient, teamKey, evidence, decision, projectName, milestoneName, backlogStateId, repo }) {
  const teamId = await linearClient.teamId(teamKey);
  if (!teamId) throw new Error(`Linear team ${teamKey} could not be resolved`);
  const labels = masterIncidentLabels();
  const { ids, missing } = await linearClient.issueLabelIds(teamKey, labels);
  if (missing.length) throw new Error(`Linear labels are missing from the workspace: ${missing.join(", ")}`);
  const project = projectName ? await linearClient.projectByName(projectName) : null;
  if (projectName && !project) throw new Error(`configured remediation project "${projectName}" was not found`);
  if (project && TERMINAL_STATE_TYPES.has(String(project.status || "").toLowerCase())) {
    throw new Error(`configured remediation project "${project.name}" is ${project.status} — it cannot own open work`);
  }
  const milestone = project && milestoneName ? project.milestones.find((candidate) => candidate.name === milestoneName) || null : null;
  const created = await linearClient.createIssue({
    teamId,
    title: masterIncidentTitle(evidence),
    description: masterIncidentIssueBody({ evidence, decision, milestoneAssigned: Boolean(milestone), repo }),
    labelIds: labels.map((name) => ids[name]),
    projectId: project?.id || null,
    projectMilestoneId: milestone?.id || null,
    stateId: backlogStateId || null,
    priority: 1,
  });
  return { ...created, project: project?.name || null, milestone: milestone?.name || null };
}

async function linkSourceIssue({ linearClient, ledger, key, evidence, remediation, dryRun }) {
  if (!evidence.sourceIssue || dryRun || ledger.hasEffect(key, "source-notice")) return null;
  const source = await linearClient.issueByIdentifier(evidence.sourceIssue);
  if (!source) return null;
  try { await linearClient.addRelatedRelation({ issueId: remediation.id, relatedIssueId: source.id }); } catch { /* a duplicate relation is harmless */ }
  await linearClient.addComment(source.id, masterIncidentSourceComment({ evidence, remediation }));
  ledger.markEffect(key, "source-notice");
  return source;
}

/** Observe failures, persist them before effects, and route each incident once. */
export async function runMasterCiPass(ctx = {}) {
  const {
    enabled = false, dryRun = false, githubRepo, linearClient, teamKey, ledger, stateIds = {}, workflows,
    runLimit = 20, maxLineageDistance = 10, routeBudget = 1, projectName = null, milestoneName = null,
    listMasterRunsFn, describeMasterRunFn, pullRequestsForCommitFn, masterCommitLineageFn, now = () => new Date(),
  } = ctx;
  if (!enabled) return [{ outcome: "disabled", reason: "MOVIECAL_MASTER_CI_OBSERVER is not enabled" }];
  if (!githubRepo) return [{ outcome: "skipped", reason: "no GitHub repository configured" }];
  const results = [];
  const masterShas = probe(() => masterCommitLineageFn({ repo: githubRepo }), []);
  const runs = probe(() => listMasterRunsFn({ repo: githubRepo, limit: runLimit }), []);
  for (const raw of runs) {
    const listed = masterRunEligibility(raw, { repo: githubRepo, workflows });
    if (!listed.eligible) { results.push({ runId: listed.run.runId, outcome: "not-a-master-incident", reason: listed.reason }); continue; }
    const detail = probe(() => describeMasterRunFn({ repo: githubRepo, runId: listed.run.runId }), null);
    const eligibility = masterRunEligibility(normalizeMasterRun({ ...raw, ...(detail || {}) }), { repo: githubRepo, workflows });
    if (!eligibility.eligible) { results.push({ runId: eligibility.run.runId, outcome: "not-a-master-incident", reason: eligibility.reason }); continue; }
    const run = eligibility.run;
    const key = masterIncidentKey({ runId: run.runId, runAttempt: run.runAttempt, headSha: run.headSha });
    const existing = ledger.get(key);
    if (existing?.status === "reconciled") { results.push({ runId: run.runId, key, outcome: "already-reconciled", reason: "this incident was already remediated and verified" }); continue; }
    if (existing?.remediation && ["routed", "needs-human-decision"].includes(existing.status)) {
      if (!dryRun) ledger.observe(key, {}, { now: now() });
      results.push({ runId: run.runId, key, issue: existing.remediation.identifier, outcome: `already-${existing.status}`, reason: existing.decision?.reason || "this incident already has a routing outcome" });
      continue;
    }
    const classification = classifyMasterFailure(run);
    const baseEvidence = {
      key, runId: run.runId, runAttempt: run.runAttempt, runUrl: run.url, workflowName: run.workflowName, lanes: classification.lanes,
      conclusion: run.conclusion, headSha: run.headSha, runCreatedAt: run.createdAt, observedAt: existing?.observedAt || now().toISOString(),
      classification: classification.classification, classificationReason: classification.reason, repo: githubRepo,
    };
    if (!dryRun) ledger.observe(key, baseEvidence, { now: now() });
    const attribution = attributeMasterRun({ pullRequests: probe(() => pullRequestsForCommitFn({ repo: githubRepo, sha: run.headSha }), []) });
    const lineage = evaluateMasterLineage({ headSha: run.headSha, masterShas, maxDistance: maxLineageDistance });
    const evidence = { ...(existing?.evidence || {}), ...baseEvidence, prNumber: attribution.prNumber, prUrl: attribution.prUrl, sourceIssue: attribution.sourceIssue, attributionReason: attribution.reason, lineageReason: lineage.reason, lineageDistance: lineage.distance };
    if (!dryRun) ledger.mergeEvidence(key, evidence);
    const budget = { used: ledger.routedCount(), limit: routeBudget };
    let decision = decideMasterIncident({ classification: classification.classification, classificationReason: classification.reason, attribution, lineage, budget, incidentCreated: true });
    if (dryRun) { results.push({ runId: run.runId, key, outcome: `would-${decision.action}`, reason: decision.reason, evidence }); continue; }
    let remediation = existing?.remediation || ledger.get(key)?.remediation || null;
    if (!remediation) {
      try {
        remediation = await createRemediationIssue({ linearClient, teamKey, evidence, decision, projectName, milestoneName, backlogStateId: stateIds.backlog || null, repo: githubRepo });
        ledger.attachRemediation(key, remediation, { now: now() });
      } catch (error) {
        decision = decideMasterIncident({ classification: classification.classification, classificationReason: `${classification.reason} (remediation issue could not be created: ${error.message})`, attribution, lineage, budget, incidentCreated: false });
        ledger.recordDecision(key, decision, { now: now() });
        ledger.setStatus(key, "needs-human-decision", decision.reason, { now: now() });
        results.push({ runId: run.runId, key, outcome: "incident-creation-failed", reason: error.message });
        continue;
      }
    }
    ledger.recordDecision(key, decision, { now: now() });
    await linkSourceIssue({ linearClient, ledger, key, evidence, remediation, dryRun });
    if (decision.action === "route-fix-pr") {
      if (!ledger.hasEffect(key, "routed")) { await linearClient.addComment(remediation.id, masterIncidentRoutedComment({ evidence, decision })); ledger.markEffect(key, "routed", { now: now() }); }
      ledger.setStatus(key, "routed", decision.reason, { now: now() });
      results.push({ runId: run.runId, key, issue: remediation.identifier, outcome: "routed", reason: decision.reason });
      continue;
    }
    if (!ledger.hasEffect(key, "needs-human-decision")) {
      if (stateIds.needsHumanDecision) await linearClient.moveToState(remediation.id, stateIds.needsHumanDecision);
      await linearClient.addComment(remediation.id, masterIncidentHumanDecisionComment({ evidence, decision }));
      ledger.markEffect(key, "needs-human-decision", { now: now() });
    }
    ledger.setStatus(key, "needs-human-decision", decision.reason, { now: now() });
    results.push({ runId: run.runId, key, issue: remediation.identifier, outcome: "needs-human-decision", reason: decision.reason });
  }
  return results;
}

/** Reconcile only a merged fix and a succeeding named lane on a newer SHA. */
export async function reconcileMasterIncidents(ctx = {}) {
  const { enabled = false, dryRun = false, githubRepo, linearClient, ledger, stateIds = {}, masterCommitLineageFn, findMergedFixPullRequestFn, latestSuccessfulMasterRunFn, reconcileLimit = 10, now = () => new Date() } = ctx;
  if (!enabled || !githubRepo) return [];
  const masterShas = probe(() => masterCommitLineageFn({ repo: githubRepo }), []);
  const results = [];
  const { due, deferred } = ledger.dueForReconciliation(reconcileLimit);
  if (deferred > 0) results.push({ outcome: "deferred", reason: `${deferred} further open incident(s) were not checked this pass (limit ${reconcileLimit}); they are checked least-recently-first on later passes` });
  for (const incident of due) {
    const remediation = incident.remediation;
    const evidence = incident.evidence || {};
    if (!dryRun) ledger.markReconcileCheck(incident.key, { now: now() });
    const mergedFixPr = probe(() => findMergedFixPullRequestFn({ repo: githubRepo, identifier: remediation.identifier }), null);
    const successfulRun = mergedFixPr ? probe(() => latestSuccessfulMasterRunFn({ repo: githubRepo, workflowName: evidence.workflowName }), null) : null;
    const verdict = canCompleteMasterIncident({ incidentSha: evidence.headSha, lane: (evidence.lanes || []).join(", ") || evidence.workflowName, mergedFixPr, successfulRun, masterShas });
    if (!verdict.complete) { results.push({ key: incident.key, issue: remediation.identifier, outcome: "still-open", reason: verdict.reason }); continue; }
    const reconciliation = { prNumber: mergedFixPr.number, prUrl: mergedFixPr.url || null, verifiedSha: successfulRun.headSha, verifiedRunUrl: successfulRun.url || null, reason: verdict.reason, at: now().toISOString() };
    if (dryRun) { results.push({ key: incident.key, issue: remediation.identifier, outcome: "would-reconcile", reason: verdict.reason }); continue; }
    if (!ledger.hasEffect(incident.key, "reconciled")) {
      await linearClient.addComment(remediation.id, masterIncidentReconciledComment({ evidence, reconciliation }));
      const snapshot = typeof linearClient.issueByIdentifier === "function" ? await linearClient.issueByIdentifier(remediation.identifier).catch(() => null) : null;
      if (stateIds.done && snapshot && !TERMINAL_STATE_TYPES.has(String(snapshot.stateType || ""))) await linearClient.moveToState(remediation.id, stateIds.done);
      ledger.markEffect(incident.key, "reconciled", { now: now() });
    }
    ledger.reconcile(incident.key, reconciliation, { now: now() });
    results.push({ key: incident.key, issue: remediation.identifier, outcome: "reconciled", reason: verdict.reason });
  }
  return results;
}

/** Read-only preview: evaluates and reports without writing anywhere. */
export async function previewMasterCiPass(ctx = {}) {
  return { observed: await runMasterCiPass({ ...ctx, dryRun: true }), reconciled: await reconcileMasterIncidents({ ...ctx, dryRun: true }) };
}

function probe(fn, fallback) {
  try { const value = fn(); return value === null || value === undefined ? fallback : value; } catch { return fallback; }
}
