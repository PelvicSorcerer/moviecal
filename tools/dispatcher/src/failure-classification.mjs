// Recognizes host-wide failure signatures in a worker's run that mean the
// local Mac's own sandbox infrastructure broke underneath the worker, not
// that the worker's task failed (MOV-180).
//
// Pure and side-effect free by design (same reasoning as security-policy.mjs
// and ci-outcomes.mjs): the interesting decision — does this transcript match
// a known environment-wide signature? — is worth unit-testing on its own,
// independent of run-loop.mjs's I/O.

/** A nested macOS Seatbelt crash: `worker-guard.mjs` already confines the
 * worker process in one `sandbox-exec` profile, and a second `sandbox_apply`
 * attempt on top of that (e.g. the harness's own tool sandboxing its own
 * child commands) is refused by the OS — a process already confined by
 * Seatbelt cannot confine its own children a second time. See
 * docs/operators/local-execution.md §Security model. */
export const NESTED_SANDBOX_CRASH = "nested-sandbox-crash";

const SANDBOX_CRASH_EXIT_CODE = 71;
const SANDBOX_CRASH_LOG_PATTERN = /sandbox_apply: Operation not permitted/;

/**
 * The original nested-Sandbox failure is emitted directly by sandbox-exec and
 * exits 71. Codex can instead catch that failed *first* tool attempt, report
 * it in a structured agent message, and exit cleanly. Do not accept the
 * marker from arbitrary text in that case: it must be Codex reporting it in
 * its own transcript, before the audit has observed any executed tool action.
 */
function codexReportsSandboxFailure(logTail) {
  for (const line of String(logTail || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event?.type === "item.completed" ? event.item : null;
      if (item?.type === "agent_message" && SANDBOX_CRASH_LOG_PATTERN.test(String(item.text || ""))) return true;
    } catch {
      // The legacy exit-71 signature intentionally still accepts unstructured
      // sandbox-exec stderr. The Codex fallback below is structured-only.
    }
  }
  return false;
}

function hasExecutedToolActivity(toolActions) {
  return Array.isArray(toolActions) && toolActions.some((action) => action?.outcome === "executed");
}

/**
 * Classify a failed worker run's exit code + log tail against known
 * host-wide failure signatures.
 *
 * The legacy fingerprint remains exit code 71 combined with the literal
 * `sandbox_apply: Operation not permitted` string anywhere in captured output.
 * Codex also has a narrower fallback for a graceful/non-71 exit: it must
 * report that exact marker in a structured agent message and the transcript
 * audit must show no executed tool action. This guards against reclassifying a
 * normal zero-change/zero-exit worker result or a sandbox string produced by
 * an otherwise-running tool.
 *
 * @param {object} args
 * @param {number} args.exitCode
 * @param {string} args.logTail - combined stdout/stderr tail, e.g. from worker-spawn.mjs's tailLogs()
 * @param {Array<{outcome?: string}>} [args.toolActions] - actions observed by the full structured transcript audit
 * @returns {{category: string}|null} the recognized category, or null when
 *   nothing matches and the caller should fall through to its existing
 *   generic-failure handling.
 */
export function classifyWorkerFailure({ exitCode, logTail, toolActions = [] }) {
  const text = String(logTail || "");
  if (exitCode === SANDBOX_CRASH_EXIT_CODE && SANDBOX_CRASH_LOG_PATTERN.test(text)) {
    return { category: NESTED_SANDBOX_CRASH };
  }
  if (codexReportsSandboxFailure(text) && !hasExecutedToolActivity(toolActions)) {
    return { category: NESTED_SANDBOX_CRASH };
  }
  return null;
}
