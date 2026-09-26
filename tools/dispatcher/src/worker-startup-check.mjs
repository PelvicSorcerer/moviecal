// MOV-386: confirm a Claude worker really started the way workerInvocation()
// asked it to.
//
// The CLI can override the requested flags without failing: with
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 and no explicit tool declaration, Claude
// Code 2.1.281 silently forced `--permission-mode dontAsk` back to `default`
// and loaded every built-in tool. The only trustworthy evidence of what a
// session actually runs with is its own stream-json `system/init` event, so
// this module compares that event against CLAUDE_WORKER_PERMISSION_MODE and
// CLAUDE_WORKER_TOOLS. A mismatch is recorded and reported loudly; it never
// kills the run (that is a later, separate decision).

import { CLAUDE_WORKER_PERMISSION_MODE, CLAUDE_WORKER_TOOLS } from "./worker-routing.mjs";

const MAX_TOOLS = 100;
// Tool names are recorded, not dropped, when they carry unexpected characters:
// an oddly named extra tool must still show up as unexpected.
const boundedName = (value) => String(value).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100) || "_";
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : null;

export function isClaudeInitEvent(event) {
  return Boolean(event) && typeof event === "object" && event.type === "system" && event.subtype === "init";
}

/**
 * Compare one init event with the expected mode and tool set. Returns a
 * bounded, redaction-safe record for the usage ledger:
 * `status` is "match", "mismatch" (wrong mode or any tool outside the
 * allowlist), or "missing" (no init event, so nothing could be confirmed).
 * An allowlisted tool the CLI did not load is listed in `missingTools` but is
 * not itself a mismatch: it narrows, never widens, what the worker can do.
 */
export function evaluateClaudeInit(event, {
  expectedPermissionMode = CLAUDE_WORKER_PERMISSION_MODE,
  expectedTools = CLAUDE_WORKER_TOOLS,
} = {}) {
  const base = {
    status: "missing",
    permissionMode: null,
    expectedPermissionMode,
    tools: null,
    expectedTools: [...expectedTools],
    unexpectedTools: [],
    missingTools: [],
    cliVersion: null,
    problems: [],
  };
  if (!isClaudeInitEvent(event)) return { ...base, problems: ["no system/init event was observed"] };

  const rawMode = event.permissionMode;
  const permissionMode = typeof rawMode === "string" ? boundedName(rawMode) : null;
  const rawTools = Array.isArray(event.tools) ? event.tools.filter((tool) => typeof tool === "string") : null;
  const tools = rawTools ? [...new Set(rawTools.map(boundedName))].slice(0, MAX_TOOLS) : null;
  const expected = new Set(expectedTools);
  const unexpectedTools = rawTools ? [...new Set(rawTools.filter((tool) => !expected.has(tool)).map(boundedName))].slice(0, MAX_TOOLS) : [];
  const missingTools = rawTools ? expectedTools.filter((tool) => !rawTools.includes(tool)) : [...expectedTools];

  const problems = [];
  if (rawMode !== expectedPermissionMode) {
    problems.push(`permissionMode is ${permissionMode === null ? "absent" : JSON.stringify(permissionMode)}, expected ${JSON.stringify(expectedPermissionMode)}`);
  }
  if (!rawTools) problems.push("the init event carried no tools list");
  else if (unexpectedTools.length) problems.push(`tools outside the allowlist: ${unexpectedTools.join(", ")}`);

  return {
    ...base,
    status: problems.length ? "mismatch" : "match",
    permissionMode,
    tools,
    unexpectedTools,
    missingTools,
    cliVersion: identifier(event.claude_code_version),
    problems,
  };
}

/**
 * Log a startup check. A mismatch is a loud warning naming exactly what
 * differed; a match is one quiet confirmation line. Returns true on mismatch.
 */
export function reportClaudeStartupCheck(check, { label, logger = console } = {}) {
  if (!check) return false;
  if (check.status === "mismatch") {
    const warn = typeof logger.warn === "function" ? logger.warn.bind(logger) : logger.error.bind(logger);
    warn(
      `WARNING (MOV-386): Claude worker for ${label} did not start as configured — ${check.problems.join("; ")}. ` +
      `The run continues, but its permission posture is not what the dispatcher intended; see docs/operators/local-execution.md §Security model.`,
    );
    return true;
  }
  if (check.status === "match" && typeof logger.log === "function") {
    logger.log(`Claude worker for ${label} started in ${check.permissionMode} mode with the allowlisted tools only.`);
  }
  return false;
}

const describeObserved = (run) => {
  const check = run.startupCheck;
  const when = run.startedAt || run.recordedAt || "unknown time";
  const tools = check.tools ? check.tools.join(", ") || "(none)" : "(not reported)";
  const version = check.cliVersion ? `, Claude Code ${check.cliVersion}` : "";
  return `${run.issue || "unknown issue"} at ${when}${version}: mode ${check.permissionMode ?? "(absent)"}; tools ${tools}`;
};

/**
 * `dispatcher doctor` line: the most recent Claude run that emitted an init
 * event decides pass/fail; a later run with no init event is called out so an
 * operator knows the latest attempt could not be confirmed.
 */
export function describeClaudeStartupCheck(runs = []) {
  const claudeRuns = runs.filter((run) => run?.worker === "claude" && run.startupCheck && typeof run.startupCheck === "object");
  const name = "Claude worker startup mode and tools";
  if (!claudeRuns.length) {
    return { name, ok: true, detail: "no Claude worker run with a recorded startup check yet — dispatch a worker:claude issue to confirm dontAsk and the explicit tool set" };
  }
  const latest = claudeRuns[claudeRuns.length - 1];
  const observed = [...claudeRuns].reverse().find((run) => run.startupCheck.status === "match" || run.startupCheck.status === "mismatch");
  const unconfirmed = latest.startupCheck.status === "missing"
    ? ` Latest run ${latest.issue || "unknown issue"} emitted no system/init event, so it could not be confirmed.`
    : "";
  if (!observed) return { name, ok: true, detail: `no Claude run has emitted a system/init event yet.${unconfirmed}` };
  if (observed.startupCheck.status === "mismatch") {
    const problems = Array.isArray(observed.startupCheck.problems) ? observed.startupCheck.problems.join("; ") : "mismatch";
    return { name, ok: false, detail: `MISMATCH — ${problems}. Last observed ${describeObserved(observed)}.${unconfirmed}` };
  }
  const missing = observed.startupCheck.missingTools?.length ? ` (allowlisted but not loaded: ${observed.startupCheck.missingTools.join(", ")})` : "";
  return { name, ok: true, detail: `matches — last observed ${describeObserved(observed)}${missing}.${unconfirmed}` };
}
