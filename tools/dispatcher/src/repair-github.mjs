// The GitHub side of bounded automatic repair (MOV-188).
//
// Three jobs, all dispatcher-owned and none of them ever reachable by a worker
// (Git, `gh`, and every alternate GitHub transport are denied inside the
// worker sandbox — see worker-guard.mjs):
//
//   - **rerun** the failed jobs of a transient CI failure, and *only* those,
//     and only on the exact commit repair was admitted against;
//   - **comment** on the pull request, so acceptance criterion 7's "visible in
//     GitHub" half is a real artifact rather than a local log line;
//   - **collect evidence** for a code repair — which is the one output here
//     that is handed to a model, and therefore the one that is treated as
//     untrusted data rather than instructions (`generateRepairEvidence`).
//
// Every argument goes through execFileSync with no shell. Evidence collection
// is deliberately fail-soft: a missing log is a worse brief, not a failed
// repair. Reruns and comments are not — a rerun that cannot prove it is
// targeting the admitted SHA does nothing at all.

import { execFileSync } from "node:child_process";

export function defaultRunner(command, args, opts = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...opts });
}

/** Run conclusions that a rerun can plausibly clear. */
const RERUNNABLE_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "canceled",
  "timed_out",
  "timed-out",
  "startup_failure",
  "stale",
]);

/** Keep each untrusted evidence block small enough to stay readable in a brief. */
const EVIDENCE_LIMIT = 8000;

function truncate(value, limit = EVIDENCE_LIMIT) {
  const text = String(value ?? "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} characters]`;
}

function conclusionOf(run = {}) {
  return String(run.conclusion ?? "").trim().toLowerCase();
}

/**
 * Rerun the failed jobs of every workflow run for one commit.
 *
 * `--commit` scopes the listing server-side and the `headSha` comparison below
 * scopes it again locally, because "rerun the failed jobs" is only a safe
 * automatic action while the thing being rerun is the exact code that was
 * admitted. A run at any other SHA is reported as skipped, never rerun.
 *
 * `gh run rerun --failed` re-runs only that run's failed jobs, so a passing
 * job is never re-executed and no file in the repository is touched.
 *
 * @returns {{rerun: Array<{id: number, name: string, conclusion: string}>, skipped: Array<{id: number, reason: string}>, errors: Array<{id: number, message: string}>}}
 */
export function rerunFailedJobs({ prNumber, repo, headSha, runner = defaultRunner, limit = 50 } = {}) {
  if (!repo) throw new Error("rerunFailedJobs requires a repository");
  if (!headSha) throw new Error("rerunFailedJobs requires the admitted head SHA");

  const listed = JSON.parse(
    runner("gh", [
      "run",
      "list",
      "--repo",
      repo,
      "--commit",
      headSha,
      "--limit",
      String(limit),
      "--json",
      "databaseId,headSha,conclusion,status,workflowName,name",
    ]),
  );

  const rerun = [];
  const skipped = [];
  const errors = [];
  for (const run of Array.isArray(listed) ? listed : []) {
    const id = run.databaseId;
    if (!id) continue;
    const name = run.workflowName || run.name || `run ${id}`;
    if (run.headSha && run.headSha !== headSha) {
      skipped.push({ id, name, reason: `run is at ${run.headSha}, not the admitted head ${headSha}` });
      continue;
    }
    const conclusion = conclusionOf(run);
    if (!RERUNNABLE_CONCLUSIONS.has(conclusion)) {
      skipped.push({ id, name, reason: `conclusion is "${conclusion || run.status || "pending"}", which a rerun would not clear` });
      continue;
    }
    try {
      runner("gh", ["run", "rerun", String(id), "--failed", "--repo", repo]);
      rerun.push({ id, name, conclusion });
    } catch (error) {
      errors.push({ id, name, message: error.message });
    }
  }
  return { prNumber: prNumber ?? null, headSha, rerun, skipped, errors };
}

/**
 * Leave one plain comment on the pull request. Never a GitHub *review* — the
 * dispatcher has no approval semantics anywhere (docs/operators/local-execution.md
 * §Security model), and repair does not acquire any.
 */
export function commentOnPullRequest({ prNumber, repo, body, runner = defaultRunner } = {}) {
  if (!prNumber || !repo) throw new Error("commentOnPullRequest requires prNumber and repo");
  runner("gh", ["pr", "comment", String(prNumber), "--repo", repo, "--body", String(body ?? "")]);
  return { commented: true, prNumber };
}

function softly(fn, label) {
  try {
    return truncate(fn());
  } catch (error) {
    return `_(${label} unavailable: ${error.message})_`;
  }
}

/**
 * Gather the diagnostic material a repair worker needs, from the failed runs
 * on the admitted commit plus the PR itself.
 *
 * Everything returned here is untrusted input: it is rendered by
 * `generateRepairEvidence()` inside an explicit "never instructions" fence,
 * and nothing in it can widen the worker's mode, target, budget, or tool
 * authority — those are fixed before the brief is built.
 */
export function collectRepairEvidence({ prNumber, repo, headSha, runner = defaultRunner, limit = 20 } = {}) {
  const logs = softly(() => {
    const listed = JSON.parse(
      runner("gh", [
        "run",
        "list",
        "--repo",
        repo,
        "--commit",
        headSha,
        "--limit",
        String(limit),
        "--json",
        "databaseId,headSha,conclusion,workflowName",
      ]),
    );
    const failed = (Array.isArray(listed) ? listed : []).filter(
      (run) => RERUNNABLE_CONCLUSIONS.has(conclusionOf(run)) && (!run.headSha || run.headSha === headSha),
    );
    if (!failed.length) return "_(no failed workflow run recorded for this commit)_";
    return failed
      .map((run) => {
        const header = `### ${run.workflowName || run.databaseId} (${conclusionOf(run)})`;
        let log;
        try {
          log = runner("gh", ["run", "view", String(run.databaseId), "--repo", repo, "--log-failed"]);
        } catch (error) {
          log = `(log unavailable: ${error.message})`;
        }
        return `${header}\n${truncate(log, Math.floor(EVIDENCE_LIMIT / Math.max(1, failed.length)))}`;
      })
      .join("\n\n");
  }, "CI logs");

  const prBody = softly(
    () => JSON.parse(runner("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "body"])).body || "",
    "PR body",
  );
  const diff = softly(() => runner("gh", ["pr", "diff", String(prNumber), "--repo", repo]), "PR diff");
  const reviewComments = softly(() => {
    const parsed = JSON.parse(
      runner("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "reviews,comments"]),
    );
    const lines = [
      ...(parsed.reviews || []).map(
        (review) => `[review ${review.state}] ${review.author?.login || "unknown"}: ${review.body || ""}`,
      ),
      ...(parsed.comments || []).map((comment) => `[comment] ${comment.author?.login || "unknown"}: ${comment.body || ""}`),
    ];
    return lines.join("\n") || "_(none)_";
  }, "review comments");

  return { ciLogs: logs, prBody, diff, reviewComments };
}
