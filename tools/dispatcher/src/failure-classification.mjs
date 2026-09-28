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

// sandbox-exec prints exactly this line (and nothing else) when it cannot
// apply its profile, then exits without starting the requested program.
const SANDBOX_STARTUP_OUTPUT_LINE = /^(?:sandbox-exec: )?sandbox_apply: Operation not permitted$/;

function isSandboxStartupOutput(output) {
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => SANDBOX_STARTUP_OUTPUT_LINE.test(line));
}

/**
 * Local sandbox health evidence from a Codex `--json` transcript (MOV-402).
 *
 * This is deliberately separate from worker-guard.mjs's security audit. The
 * audit records every *attempted* command as `executed` once the harness
 * handed it on, so that violations are never lost; that is the right answer
 * for security and the wrong one for "did a local command actually start".
 * Here only native `item.completed` events count, keyed by item id so
 * duplicate started/completed events cannot manufacture extra activity:
 *
 * - a `command_execution` with a nonzero exit code whose entire output is the
 *   sandbox-exec refusal line is a *startup failure*: the shell never ran;
 * - any other completed `command_execution` with a numeric exit code (zero or
 *   an ordinary nonzero failure) proves the local sandbox started a program;
 * - a completed `file_change` proves the worker wrote locally.
 *
 * Remote tool calls (MCP, web) and agent narration prove nothing about the
 * local sandbox either way.
 *
 * @param {string} transcript - full structured stdout.log
 * @returns {{startupFailures: Array<{command: string, exitCode: number}>, successfulLocalActivity: number}}
 */
export function assessLocalSandboxStartup(transcript) {
  const failures = new Map();
  const successes = new Set();
  let anonymous = 0;
  for (const line of String(transcript || "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event?.type === "item.completed" ? event.item : null;
    if (!item || typeof item !== "object") continue;
    const key = item.id ?? `anonymous-${anonymous++}`;
    if (item.type === "command_execution" && Number.isInteger(item.exit_code)) {
      if (item.exit_code !== 0 && isSandboxStartupOutput(item.aggregated_output)) {
        failures.set(key, { command: String(item.command ?? ""), exitCode: item.exit_code });
      } else {
        successes.add(key);
      }
    } else if (item.type === "file_change" && String(item.status || "completed") === "completed") {
      successes.add(key);
    }
  }
  return { startupFailures: [...failures.values()], successfulLocalActivity: successes.size };
}

/**
 * Classify a failed worker run's exit code + transcript against known
 * host-wide failure signatures.
 *
 * Three signatures, most specific first:
 *
 * 1. Legacy: outer exit code 71 combined with the literal
 *    `sandbox_apply: Operation not permitted` anywhere in captured output.
 * 2. Native (MOV-402): Codex's own completed `command_execution` event shows
 *    a command that sandbox-exec refused to start (see
 *    assessLocalSandboxStartup), and no completed local command or file change
 *    succeeded anywhere in the run. This holds whatever the outer exit code
 *    and whatever the model said, and does not consult the security audit's
 *    `executed` outcome, which records attempts rather than startup.
 * 3. Narrated (MOV-299): Codex reports the exact marker in a structured agent
 *    message, the transcript shows no successful local activity, and the audit
 *    shows no executed tool action.
 *
 * Any successful local activity rules out 2 and 3: the sandbox demonstrably
 * worked for this worker, so its result follows the normal paths.
 *
 * @param {object} args
 * @param {number} args.exitCode
 * @param {string} args.logTail - combined stdout/stderr tail, e.g. from worker-spawn.mjs's tailLogs()
 * @param {string} [args.transcript] - the full structured stdout.log; defaults to logTail
 * @param {Array<{outcome?: string}>} [args.toolActions] - actions observed by the full structured transcript audit
 * @returns {{category: string, signature: "exit-71"|"native-command"|"agent-report"}|null}
 *   the recognized category, or null when nothing matches and the caller
 *   should fall through to its existing generic-failure handling.
 */
export function classifyWorkerFailure({ exitCode, logTail, transcript, toolActions = [] }) {
  const text = String(logTail || "");
  if (exitCode === SANDBOX_CRASH_EXIT_CODE && SANDBOX_CRASH_LOG_PATTERN.test(text)) {
    return { category: NESTED_SANDBOX_CRASH, signature: "exit-71" };
  }
  const structured = transcript ?? text;
  const health = assessLocalSandboxStartup(structured);
  if (health.successfulLocalActivity > 0) return null;
  if (health.startupFailures.length > 0) {
    return { category: NESTED_SANDBOX_CRASH, signature: "native-command" };
  }
  if (codexReportsSandboxFailure(structured) && !hasExecutedToolActivity(toolActions)) {
    return { category: NESTED_SANDBOX_CRASH, signature: "agent-report" };
  }
  return null;
}
