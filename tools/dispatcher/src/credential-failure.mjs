// Detects the dispatcher's own worker credential going bad (MOV-177): a
// worker result whose exit carries a 401/`authentication_failed` signature
// means the local Mac's configured credential (`CLAUDE_CODE_OAUTH_TOKEN`
// today) is invalid or expired -- not that this issue's task failed. The
// credential is dispatcher-wide, so every worker fails identically until a
// human regenerates it; observed three separate times (MOV-172, MOV-173,
// MOV-175), each reported as an unrelated generic task failure. See
// docs/operators/local-execution.md §Security model.
//
// This mirrors failure-classification.mjs's NESTED_SANDBOX_CRASH shape
// deliberately: both are host-wide conditions a worker's exit can reveal,
// both requeue the surfaced issue to Ready for Agent instead of escalating
// it, and both trip the same shared, named CircuitBreakerStore
// (circuit-breaker.mjs) to stop the dispatcher from burning through the rest
// of the queue one issue at a time. Kept in its own module rather than folded
// into failure-classification.mjs because the two conditions have unrelated
// signatures and unrelated recovery stories (a Mac-level sandbox bug vs. a
// credential rotation) -- see run-loop.mjs for where the two are composed.
//
// Detection reads structured worker error events only (MOV-4xx): a signature
// quoted inside tool output or other transcript text never matches.
//
// Deliberately narrow, mirroring usage-limit.mjs's classifyUsageLimitFailure:
// a zero exit is never this class, and only known auth-failure signatures
// match -- an unrelated "401" buried in ordinary test/app output (e.g. a
// legitimate auth-gate integration test asserting a 401 response) must not
// trip a dispatcher-wide breaker. The classifier keys off the error
// signature itself, never off "this issue failed more than once", so it
// cannot misfire on an unrelated repeated failure.

/** The recognized category name, mirroring NESTED_SANDBOX_CRASH's role. */
export const CREDENTIAL_FAILURE = "credential-failure";

// Free-text signatures, applied only to a worker's own error message (an
// error event's `error`/`message` field) or to a non-JSON stderr line --
// never to arbitrary transcript text, which includes tool output (an `rg`
// over docs/ that prints an example error line is not a login failure).
const CREDENTIAL_FAILURE_MESSAGE_PATTERNS = [
  // The provider's structured error code, when it appears as message text.
  /"error"\s*:\s*"authentication_failed"/i,
  // The literal message observed in production (MOV-172/173/175 incidents).
  /OAuth access token has expired/i,
  // The equivalent signature for an API-key-based credential (MOV-176, not
  // yet in use, but the classifier should not need to change when it is).
  /invalid api key/i,
];

const MAX_DEPTH = 4;

function evidenceFromMessage(text) {
  for (const pattern of CREDENTIAL_FAILURE_MESSAGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

// Claude Code: `{"type":"error",...}` / `{"type":"result","is_error":true,...}`;
// Codex: `{"type":"error"|"turn.failed",...}` or an item of type "error".
// Tool-output carriers (`user` tool_result, command_execution items) are
// deliberately not error events.
function errorPayload(event) {
  if (!event || typeof event !== "object") return null;
  if (event.item?.type === "error") return event.item;
  const type = String(event.type ?? "");
  if (type === "error" || type === "turn.failed" || event.is_error === true) return event;
  return null;
}

function scanStructured(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return null;
  for (const [key, value] of Object.entries(node)) {
    if (key === "api_error_status" && Number(value) === 401) return `"api_error_status":401`;
    if (key === "error" && value === "authentication_failed") return `"error":"authentication_failed"`;
    if ((key === "error" || key === "message") && typeof value === "string") {
      const found = evidenceFromMessage(value);
      if (found) return found;
    }
    if (value && typeof value === "object") {
      const found = scanStructured(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function classifyLine(line) {
  const trimmed = line.trim();
  if (!trimmed || /^--- .* ---$/.test(trimmed)) return null;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // Not a JSON event: plain stderr from the CLI itself.
    return evidenceFromMessage(trimmed);
  }
  const payload = errorPayload(event);
  return payload ? scanStructured(payload) : null;
}

/**
 * Does a failed worker run carry the dispatcher-credential-failure signature?
 *
 * @param {object} args
 * @param {number} args.exitCode - a zero exit is never this class; the worker ran
 * @param {string} args.logTail - combined stdout/stderr tail (worker-spawn.mjs's tailLogs())
 * @returns {{category: string, evidence: string}|null} null when the run is an
 *   ordinary failure, which the caller must keep handling exactly as it does today.
 */
export function classifyCredentialFailure({ exitCode, logTail } = {}) {
  if (exitCode === 0) return null;
  for (const line of String(logTail ?? "").split("\n")) {
    const evidence = classifyLine(line);
    if (evidence) {
      return { category: CREDENTIAL_FAILURE, evidence: evidence.replace(/\s+/g, " ").trim().slice(0, 300) };
    }
  }
  return null;
}
