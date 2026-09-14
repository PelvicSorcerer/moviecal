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
 * Classify a failed worker run's exit code + log tail against known
 * host-wide failure signatures.
 *
 * The nested-sandbox-crash fingerprint is exit code 71 combined with the
 * literal `sandbox_apply: Operation not permitted` string anywhere in the
 * captured output. This pair only ever occurs when the sandboxed child
 * process itself never ran — which is also why "no successful tool calls"
 * (named in the confirmed signature) does not need a separate check here: a
 * worker that crashes on its very first sandboxed subprocess call never gets
 * far enough to make one.
 *
 * @param {object} args
 * @param {number} args.exitCode
 * @param {string} args.logTail - combined stdout/stderr tail, e.g. from worker-spawn.mjs's tailLogs()
 * @returns {{category: string}|null} the recognized category, or null when
 *   nothing matches and the caller should fall through to its existing
 *   generic-failure handling.
 */
export function classifyWorkerFailure({ exitCode, logTail }) {
  if (exitCode === SANDBOX_CRASH_EXIT_CODE && SANDBOX_CRASH_LOG_PATTERN.test(String(logTail || ""))) {
    return { category: NESTED_SANDBOX_CRASH };
  }
  return null;
}
