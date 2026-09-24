// Preflight gates: everything that must be true before the dispatcher will
// start a worker on a Linear issue. See docs/operators/local-execution.md
// §Preflight gates.
//
// Pure decision logic lives here; the actual I/O (checking the runner,
// checking a secret file, listing active worktrees) is gathered by the
// caller and passed in as `context`, so this module is fully unit-testable
// without touching the network or the filesystem.
//
// MOV-303 adds the issue-completeness gate (`issue-spec.mjs`) here too, not
// only in the promoter: an issue can reach `Ready for Agent` without ever
// passing through the promoter (a human, a Loop, or any other actor moving
// it there by hand), so preflight -- the one gate every dispatched issue
// passes through regardless of how it arrived -- is where the contract is
// actually enforced. The promoter's own gate remains useful as an earlier,
// cheaper checkpoint, but preflight is what nothing can bypass.

import { evaluateIssueSpec, formatIssueSpecMissing, DEFAULT_ISSUE_SPEC_MODE } from "./issue-spec.mjs";

const WORKFLOW_EDIT_LABEL = "ci:workflow-edit-authorized";
const WORKFLOW_EDIT_MARKER_RE = /^Workflow-edit:\s*(\S+)\s*$/gim;
const WORKFLOW_EDIT_PATH_RE = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;

/**
 * Resolves whether an issue is authorized to propose a change to exactly one
 * named .github/workflows/ file via the staged-apply mechanism (MOV-121; see
 * docs/operators/local-execution.md §Security model). The worker's own
 * Edit(.github/workflows/**) hard-deny is never lifted -- this only decides
 * whether run-loop.mjs's post-worker apply step is allowed to act, and on
 * exactly which file.
 *
 * Fails closed: any mismatch between the label and a single valid marker is
 * NOT authorized and carries a reason, meant to surface as a preflight
 * failure rather than being silently ignored. `reason: null` means the issue
 * simply isn't attempting this at all -- the normal case for ~every issue.
 *
 * @param {{ labels?: string[], description?: string }} issue
 * @returns {{ authorized: true, path: string } | { authorized: false, reason: string | null }}
 */
export function resolveWorkflowEditAuthorization(issue) {
  const labels = issue.labels || [];
  const description = issue.description || "";
  const hasLabel = labels.includes(WORKFLOW_EDIT_LABEL);
  const matches = [...description.matchAll(WORKFLOW_EDIT_MARKER_RE)];

  if (!hasLabel && matches.length === 0) {
    return { authorized: false, reason: null };
  }
  if (!hasLabel) {
    return {
      authorized: false,
      reason: `description declares a Workflow-edit marker but the issue isn't labeled ${WORKFLOW_EDIT_LABEL}`,
    };
  }
  if (matches.length === 0) {
    return {
      authorized: false,
      reason: `labeled ${WORKFLOW_EDIT_LABEL} but description has no "Workflow-edit: <path>" marker`,
    };
  }
  if (matches.length > 1) {
    return {
      authorized: false,
      reason: `description declares ${matches.length} Workflow-edit markers -- exactly one is required`,
    };
  }

  const path = matches[0][1];
  if (!WORKFLOW_EDIT_PATH_RE.test(path)) {
    return {
      authorized: false,
      reason: `Workflow-edit marker path "${path}" must be a single .github/workflows/*.yml or *.yaml file`,
    };
  }

  return { authorized: true, path };
}

/**
 * @param {object} issue - Linear issue: { id, labels: string[], blockedByIds: string[], project: string|null }
 * @param {object} context
 * @param {(id: string) => boolean} context.isIssueSatisfied - true if a blocking issue is resolved
 * @param {boolean} context.iosRunnerOnline
 * @param {number} context.activeWorktreeCount
 * @param {number} context.concurrencyLimit
 * @param {(secretName: string) => boolean} context.secretPresent
 * @param {(path: string) => boolean|string} context.worktreePathFree - true
 *   when free; false for a plain (generic-message) block; a string for a
 *   block with a specific reason to surface instead (MOV-185, e.g. a
 *   same-issue terminal worktree that was not reclaimed because it is dirty)
 * @param {string} context.candidateWorktreePath
 * @param {"off"|"report"|"enforce"} [context.issueSpecMode] - MOV-303;
 *   defaults to `report`. `enforce` fails preflight for an incomplete issue,
 *   naming every missing item; `report`/`off` never affect `ok`, but
 *   `specViolations` on the return value still carries whatever `report`
 *   would have blocked on, for the caller to log.
 * @returns {{ ok: boolean, reason: string|null, specViolations: string[] }}
 */
export function evaluatePreflight(issue, context) {
  const labels = issue.labels || [];
  const issueSpecMode = context.issueSpecMode ?? DEFAULT_ISSUE_SPEC_MODE;
  // MOV-303: computed once, up front, and attached to every return below
  // (including the earliest ones) so `report` mode's whole purpose -- seeing
  // violations on an issue regardless of why (or whether) it was otherwise
  // blocked -- holds no matter which check below is what actually decided
  // `ok`.
  const spec = issueSpecMode === "off" ? { missing: [] } : evaluateIssueSpec(issue);
  const specViolations = spec.missing.map((item) => item.message);

  if (labels.includes("human-only")) {
    return { ok: false, reason: "labeled human-only: never a dispatch candidate", specViolations };
  }

  const workflowAuth = resolveWorkflowEditAuthorization(issue);
  if (!workflowAuth.authorized && workflowAuth.reason) {
    return {
      ok: false,
      reason: `workflow-edit authorization misconfigured: ${workflowAuth.reason}`,
      specViolations,
    };
  }

  // MOV-303: the completeness gate, mirroring the promoter's own placement
  // (evaluatePromotion, issue-spec.mjs) -- before the operational checks
  // below, since an incomplete issue is a specification problem, not a
  // capacity or environment one. `report`/`off` never fail preflight here;
  // this is what actually stops dispatch of an incomplete issue that reached
  // `Ready for Agent` some way other than the promoter (a human move, a
  // Loop, anything) -- the one gate every dispatched issue passes through.
  if (issueSpecMode === "enforce" && specViolations.length > 0) {
    return {
      ok: false,
      reason: `incomplete issue spec (MOV-303): ${formatIssueSpecMissing(spec.missing)}`,
      specViolations,
    };
  }

  const blockedByIds = issue.blockedByIds || [];
  const unresolved = blockedByIds.filter((id) => !context.isIssueSatisfied(id));
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: `blocked by unresolved relation(s): ${unresolved.join(", ")}`,
      specViolations,
    };
  }

  if (labels.includes("needs-secrets")) {
    const secretLabel = labels.find((l) => l.startsWith("needs-secret:"));
    const secretName = secretLabel ? secretLabel.slice("needs-secret:".length) : null;
    const present = secretName ? context.secretPresent(secretName) : context.secretPresent("default");
    if (!present) {
      return {
        ok: false,
        reason: secretName
          ? `labeled needs-secrets: required local secret '${secretName}' is not present`
          : "labeled needs-secrets: required local secret is not present",
        specViolations,
      };
    }
  }

  if (issue.project === "iOS Companion App" && !context.iosRunnerOnline) {
    return {
      ok: false,
      reason: "iOS Companion App project requires the self-hosted macOS runner (moviecal-ios-runner) to be online",
      specViolations,
    };
  }

  if (context.activeWorktreeCount >= context.concurrencyLimit) {
    return {
      ok: false,
      reason: `concurrency limit reached (${context.activeWorktreeCount}/${context.concurrencyLimit} worktrees active)`,
      specViolations,
    };
  }

  const pathFree = context.worktreePathFree(context.candidateWorktreePath);
  if (pathFree !== true) {
    return {
      ok: false,
      reason: typeof pathFree === "string"
        ? pathFree
        : `worktree path already in use: ${context.candidateWorktreePath}`,
      specViolations,
    };
  }

  return { ok: true, reason: null, specViolations };
}

/** Slugify a Linear issue title into a short branch/worktree-safe fragment. */
export function slugify(title, maxLen = 40) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

export function worktreeName(issueIdentifier, title) {
  return `${issueIdentifier}-${slugify(title)}`;
}

export function branchName(issueIdentifier, title) {
  return `agent/${worktreeName(issueIdentifier, title)}`;
}
