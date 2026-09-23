// The post-merge `master` failure observer (MOV-305).
//
// This is the effectful half: it reads GitHub (master-ci-github.mjs), asks
// master-ci-policy.mjs what to do, persists the answer in the incident ledger,
// and publishes exactly one remediation record per incident to Linear.
//
// Three properties are worth stating plainly, because they are the ones a
// reviewer should check rather than trust:
//
//   1. **Nothing here can act on `master`.** The only mutations this module
//      performs are Linear ones (`createIssue`, `addComment`, `moveToState`,
//      `addRelatedRelation`) plus its own ledger file. It imports no Git, no
//      push, no rerun, and no repair worker. A "fix" is routed by filing a
//      fully specced issue that the ordinary promote → delegate → dispatch
//      path picks up, and that path already branches from current `master`
//      and opens a draft PR.
//   2. **The observation is persisted before any follow-up mutation.** A
//      crash between observing and creating the remediation issue resumes as
//      "recorded, nothing created yet", never as a duplicate and never as a
//      lost incident.
//   3. **Every Linear side effect is marked in the ledger before it is
//      considered done.** Re-observation after a restart therefore updates the
//      original record rather than re-commenting, re-creating, or re-routing.
//
// The open-PR observation and bounded-repair path (review-ci-observer.mjs,
// repair-run.mjs) is untouched by all of this; a merged PR simply stops being
// their concern and becomes this module's.

import {
  attributeMasterRun,
  canCompleteMasterIncident,
  classifyMasterFailure,
  decideMasterIncident,
  evaluateMasterLineage,
  masterIncidentKey,
  masterRunEligibility,
  normalizeMasterRun,
} from "./master-ci-policy.mjs";
import {
  masterIncidentHumanDecisionComment,
  masterIncidentIssueBody,
  masterIncidentLabels,
  masterIncidentReconciledComment,
  masterIncidentRoutedComment,
  masterIncidentSourceComment,
  masterIncidentTitle,
} from "./master-incident-issue.mjs";

/** Linear workflow-state types that mean "already finished; do not rewrite". */
const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Build the remediation issue for one incident.
 *
 * Every lookup that can fail is allowed to fail loudly: a remediation issue
 * filed without its execution route, labels, or project would sit in the
 * backlog forever and look like a working feature. A throw here becomes the
 * `incidentCreated: false` branch of `decideMasterIncident()`, which is an
 * explicit "a human must file this" outcome rather than a silent gap.
 */
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
  const milestone = project && milestoneName
    ? project.milestones.find((candidate) => candidate.name === milestoneName) || null
    : null;
  // A project that defines milestones but whose configured milestone did not
  // resolve is the case the explicit opt-out line exists for: file it with a
  // reasoned opt-out rather than incomplete.
  const milestoneAssigned = Boolean(milestone);

  const created = await linearClient.createIssue({
    teamId,
    title: masterIncidentTitle(evidence),
    description: masterIncidentIssueBody({ evidence, decision, milestoneAssigned, repo }),
    labelIds: labels.map((name) => ids[name]),
    projectId: project?.id || null,
    projectMilestoneId: milestone?.id || null,
    stateId: backlogStateId || null,
    // Urgent: a red `master` blocks everybody's merges, and priority
    // propagation will raise it anyway once anything depends on it.
    priority: 1,
  });
  return { ...created, project: project?.name || null, milestone: milestone?.name || null };
}

/** Link the remediation item back to the source issue, and say so once, there. */
async function linkSourceIssue({ linearClient, ledger, key, evidence, remediation, dryRun }) {
  if (!evidence.sourceIssue || dryRun) return null;
  if (ledger.hasEffect(key, "source-notice")) return null;
  const source = await linearClient.issueByIdentifier(evidence.sourceIssue);
  if (!source) return null;
  try {
    await linearClient.addRelatedRelation({ issueId: remediation.id, relatedIssueId: source.id });
  } catch {
    // A duplicate or refused relation must never cost the incident its
    // notice comment; the comment is the part a human actually reads.
  }
  await linearClient.addComment(source.id, masterIncidentSourceComment({ evidence, remediation }));
  ledger.markEffect(key, "source-notice");
  return source;
}

/**
 * Observe every completed failed `push` run on `master` and give each one
 * exactly one durable, attributable remediation record.
 *
 * @returns {Promise<Array<object>>} one result per considered run
 */
export async function runMasterCiPass(ctx = {}) {
  const {
    enabled = false,
    dryRun = false,
    githubRepo,
    linearClient,
    teamKey,
    ledger,
    stateIds = {},
    workflows,
    runLimit = 20,
    maxLineageDistance = 10,
    routeBudget = 1,
    projectName = null,
    milestoneName = null,
    listMasterRunsFn,
    describeMasterRunFn,
    pullRequestsForCommitFn,
    masterCommitLineageFn,
    now = () => new Date(),
  } = ctx;

  if (!enabled) return [{ outcome: "disabled", reason: "MOVIECAL_MASTER_CI_OBSERVER is not enabled" }];
  if (!githubRepo) return [{ outcome: "skipped", reason: "no GitHub repository configured" }];

  const results = [];
  const masterShas = probe(() => masterCommitLineageFn({ repo: githubRepo }), []);
  const runs = probe(() => listMasterRunsFn({ repo: githubRepo, limit: runLimit }), []);

  for (const raw of runs) {
    const listEligibility = masterRunEligibility(raw, { repo: githubRepo, workflows });
    if (!listEligibility.eligible) {
      results.push({ runId: listEligibility.run.runId, outcome: "not-a-master-incident", reason: listEligibility.reason });
      continue;
    }
    // The attempt number and per-job conclusions are only available from the
    // detail read, and the attempt is half of the incident's identity.
    const detail = probe(() => describeMasterRunFn({ repo: githubRepo, runId: listEligibility.run.runId }), null);
    const merged = normalizeMasterRun({ ...raw, ...(detail || {}) });
    const eligibility = masterRunEligibility(merged, { repo: githubRepo, workflows });
    if (!eligibility.eligible) {
      results.push({ runId: merged.runId, outcome: "not-a-master-incident", reason: eligibility.reason });
      continue;
    }
    const run = eligibility.run;
    const key = masterIncidentKey({ runId: run.runId, runAttempt: run.runAttempt, headSha: run.headSha });
    const existing = ledger.get(key);
    if (existing?.status === "reconciled") {
      results.push({ runId: run.runId, key, outcome: "already-reconciled", reason: "this incident was already remediated and verified" });
      continue;
    }
    // An incident that already has its remediation item *and* a routing
    // outcome is finished as far as observation is concerned. Re-deciding it
    // would be wrong twice over: the routed one would read its own spent
    // budget as exhaustion and re-escalate, and the escalated one would
    // silently re-route the moment somebody else's incident closed. A repeat
    // observation refreshes the counter and nothing else.
    if (existing?.remediation && ["routed", "needs-human-decision"].includes(existing.status)) {
      if (!dryRun) ledger.observe(key, {}, { now: now() });
      results.push({
        runId: run.runId,
        key,
        issue: existing.remediation.identifier,
        outcome: `already-${existing.status}`,
        reason: existing.decision?.reason || "this incident already has a routing outcome",
      });
      continue;
    }

    const classification = classifyMasterFailure(run);
    const baseEvidence = {
      key,
      runId: run.runId,
      runAttempt: run.runAttempt,
      runUrl: run.url,
      workflowName: run.workflowName,
      lanes: classification.lanes,
      conclusion: run.conclusion,
      headSha: run.headSha,
      runCreatedAt: run.createdAt,
      observedAt: existing?.observedAt || now().toISOString(),
      classification: classification.classification,
      classificationReason: classification.reason,
      repo: githubRepo,
    };

    // ---- persist the observation before any follow-up mutation ----
    if (!dryRun) ledger.observe(key, baseEvidence, { now: now() });

    const attribution = attributeMasterRun({
      pullRequests: probe(() => pullRequestsForCommitFn({ repo: githubRepo, sha: run.headSha }), []),
    });
    const lineage = evaluateMasterLineage({ headSha: run.headSha, masterShas, maxDistance: maxLineageDistance });
    const evidence = {
      ...(existing?.evidence || {}),
      ...baseEvidence,
      prNumber: attribution.prNumber,
      prUrl: attribution.prUrl,
      sourceIssue: attribution.sourceIssue,
      attributionReason: attribution.reason,
      lineageReason: lineage.reason,
      lineageDistance: lineage.distance,
    };
    if (!dryRun) ledger.mergeEvidence(key, evidence);

    const budget = { used: ledger.routedCount(), limit: routeBudget };
    let decision = decideMasterIncident({
      classification: classification.classification,
      classificationReason: classification.reason,
      attribution,
      lineage,
      budget,
      incidentCreated: true,
    });

    if (dryRun) {
      results.push({ runId: run.runId, key, outcome: `would-${decision.action}`, reason: decision.reason, evidence });
      continue;
    }

    // ---- one remediation record per incident, created or reused ----
    let remediation = existing?.remediation || ledger.get(key)?.remediation || null;
    if (!remediation) {
      try {
        remediation = await createRemediationIssue({
          linearClient,
          teamKey,
          evidence,
          decision,
          projectName,
          milestoneName,
          backlogStateId: stateIds.backlog || null,
          repo: githubRepo,
        });
        ledger.attachRemediation(key, remediation, { now: now() });
      } catch (error) {
        decision = decideMasterIncident({
          classification: classification.classification,
          classificationReason: `${classification.reason} (remediation issue could not be created: ${error.message})`,
          attribution,
          lineage,
          budget,
          incidentCreated: false,
        });
        ledger.recordDecision(key, decision, { now: now() });
        ledger.setStatus(key, "needs-human-decision", decision.reason, { now: now() });
        results.push({ runId: run.runId, key, outcome: "incident-creation-failed", reason: error.message });
        continue;
      }
    }

    ledger.recordDecision(key, decision, { now: now() });
    await linkSourceIssue({ linearClient, ledger, key, evidence, remediation, dryRun });

    // ---- route, exactly once ----
    if (decision.action === "route-fix-pr") {
      if (!ledger.hasEffect(key, "routed")) {
        await linearClient.addComment(remediation.id, masterIncidentRoutedComment({ evidence, decision }));
        ledger.markEffect(key, "routed", { now: now() });
      }
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

/**
 * Close out remediation items whose fix actually landed.
 *
 * Both halves are required and neither is inferred: the fix PR must be
 * merged, and the lane that originally failed must have succeeded on a
 * `master` commit that is strictly newer than the failing one. A green re-run
 * of the original SHA proves the run was flaky, not that the defect is gone,
 * and `canCompleteMasterIncident()` refuses it.
 */
export async function reconcileMasterIncidents(ctx = {}) {
  const {
    enabled = false,
    dryRun = false,
    githubRepo,
    linearClient,
    ledger,
    stateIds = {},
    masterCommitLineageFn,
    findMergedFixPullRequestFn,
    latestSuccessfulMasterRunFn,
    reconcileLimit = 10,
    now = () => new Date(),
  } = ctx;

  if (!enabled) return [];
  if (!githubRepo) return [];

  const masterShas = probe(() => masterCommitLineageFn({ repo: githubRepo }), []);
  const results = [];
  const { due, deferred } = ledger.dueForReconciliation(reconcileLimit);
  // Never a silent cap: a deferred incident is named in the results so an
  // operator sees that this pass did not cover everything open.
  if (deferred > 0) {
    results.push({
      outcome: "deferred",
      reason: `${deferred} further open incident(s) were not checked this pass (limit ${reconcileLimit}); they are checked least-recently-first on later passes`,
    });
  }
  for (const incident of due) {
    const remediation = incident.remediation;
    const evidence = incident.evidence || {};
    if (!dryRun) ledger.markReconcileCheck(incident.key, { now: now() });
    const mergedFixPr = probe(
      () => findMergedFixPullRequestFn({ repo: githubRepo, identifier: remediation.identifier }),
      null,
    );
    const successfulRun = mergedFixPr
      ? probe(() => latestSuccessfulMasterRunFn({ repo: githubRepo, workflowName: evidence.workflowName }), null)
      : null;
    const verdict = canCompleteMasterIncident({
      incidentSha: evidence.headSha,
      lane: (evidence.lanes || []).join(", ") || evidence.workflowName,
      mergedFixPr,
      successfulRun,
      masterShas,
    });
    if (!verdict.complete) {
      results.push({ key: incident.key, issue: remediation.identifier, outcome: "still-open", reason: verdict.reason });
      continue;
    }
    const reconciliation = {
      prNumber: mergedFixPr.number,
      prUrl: mergedFixPr.url || null,
      verifiedSha: successfulRun.headSha,
      verifiedRunUrl: successfulRun.url || null,
      reason: verdict.reason,
      at: now().toISOString(),
    };
    if (dryRun) {
      results.push({ key: incident.key, issue: remediation.identifier, outcome: "would-reconcile", reason: verdict.reason });
      continue;
    }
    if (!ledger.hasEffect(incident.key, "reconciled")) {
      await linearClient.addComment(remediation.id, masterIncidentReconciledComment({ evidence, reconciliation }));
      const snapshot = typeof linearClient.issueByIdentifier === "function"
        ? await linearClient.issueByIdentifier(remediation.identifier).catch(() => null)
        : null;
      // Never rewrite a state a human or the GitHub magic-word sync already
      // moved to a terminal one; this backstops that sync, it does not race it.
      if (stateIds.done && snapshot && !TERMINAL_STATE_TYPES.has(String(snapshot.stateType || ""))) {
        await linearClient.moveToState(remediation.id, stateIds.done);
      }
      ledger.markEffect(incident.key, "reconciled", { now: now() });
    }
    ledger.reconcile(incident.key, reconciliation, { now: now() });
    results.push({ key: incident.key, issue: remediation.identifier, outcome: "reconciled", reason: verdict.reason });
  }
  return results;
}

/** Read-only preview: evaluates and reports, and writes nothing anywhere. */
export async function previewMasterCiPass(ctx = {}) {
  const observed = await runMasterCiPass({ ...ctx, dryRun: true });
  const reconciled = await reconcileMasterIncidents({ ...ctx, dryRun: true });
  return { observed, reconciled };
}

/**
 * A GitHub read that fails soft. An unavailable listing degrades this pass to
 * "saw nothing this cycle" — which a later cycle corrects — rather than
 * aborting the dispatcher's poll.
 */
function probe(fn, fallback) {
  try {
    const value = fn();
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}
