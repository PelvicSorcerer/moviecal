// Preflight gates: everything that must be true before the dispatcher will
// start a worker on a Linear issue. See docs/operators/local-execution.md
// §Preflight gates.
//
// Pure decision logic lives here; the actual I/O (checking the runner,
// checking a secret file, listing active worktrees) is gathered by the
// caller and passed in as `context`, so this module is fully unit-testable
// without touching the network or the filesystem.

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
 * @param {(path: string) => boolean} context.worktreePathFree
 * @param {string} context.candidateWorktreePath
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function evaluatePreflight(issue, context) {
  const labels = issue.labels || [];

  if (labels.includes("human-only")) {
    return { ok: false, reason: "labeled human-only: never a dispatch candidate" };
  }

  const workflowAuth = resolveWorkflowEditAuthorization(issue);
  if (!workflowAuth.authorized && workflowAuth.reason) {
    return { ok: false, reason: `workflow-edit authorization misconfigured: ${workflowAuth.reason}` };
  }

  const blockedByIds = issue.blockedByIds || [];
  const unresolved = blockedByIds.filter((id) => !context.isIssueSatisfied(id));
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: `blocked by unresolved relation(s): ${unresolved.join(", ")}`,
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
      };
    }
  }

  if (issue.project === "iOS Companion App" && !context.iosRunnerOnline) {
    return {
      ok: false,
      reason: "iOS Companion App project requires the self-hosted macOS runner (moviecal-ios-runner) to be online",
    };
  }

  if (context.activeWorktreeCount >= context.concurrencyLimit) {
    return {
      ok: false,
      reason: `concurrency limit reached (${context.activeWorktreeCount}/${context.concurrencyLimit} worktrees active)`,
    };
  }

  if (!context.worktreePathFree(context.candidateWorktreePath)) {
    return {
      ok: false,
      reason: `worktree path already in use: ${context.candidateWorktreePath}`,
    };
  }

  return { ok: true, reason: null };
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
