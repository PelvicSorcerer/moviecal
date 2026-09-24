#!/usr/bin/env node

// iOS simulator guard hook (MOV-311). Reads a Claude Code PreToolUse hook
// payload on stdin and decides allow/deny: any Bash command or iOS Simulator
// MCP action that mutates simulator state is denied unless a live machine-wide
// lease (scripts/ios-sim-lease.mjs, MOV-309) already covers the caller's lane.
// Wiring it into .claude/settings.json is a separate, human-only step
// (.claude/** is edit-denied for workers; AGENTS.md §Security model).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectLane, leaseLiveness } from "./lib/ios-sim-lease-core.mjs";
import { createEnvironment } from "./ios-sim-lease.mjs";

const ACQUIRE_INSTRUCTION = "Run `npm run ios:sim:acquire` to get a live iOS simulator lease before this action.";
const MANUAL_RELEASE_INSTRUCTION =
  "If you set this simulator up for the user's manual testing, run `npm run ios:sim:release` as soon as the user says they are finished testing.";

const MUTATING_BASH_PATTERNS = [
  /\bsimctl\b[^\n]*\bboot\b/iu,
  /\bsimctl\b[^\n]*\binstall\b/iu,
  /\bsimctl\b[^\n]*\blaunch\b/iu,
  /\bsimctl\b[^\n]*\bshutdown\b/iu,
  /\bsimctl\b[^\n]*\berase\b/iu,
  /(^|[\s/])xcodebuild\b/iu,
  /\bopen\b[^\n]*Simulator\.app/iu,
];

const READ_ONLY_BASH_PATTERNS = [/\bsimctl\b[^\n]*\blist\b/iu, /\bios:sim:status\b/u, /\bios-sim-lease\.mjs\b[^\n]*\bstatus\b/u];

// Matched as a whole underscore-delimited token (e.g. "ui_tap", "boot_simulator")
// rather than a bare substring, so a read-only action that merely contains one
// of these words mid-token (e.g. "get_booted_sim_id") is never misclassified.
const MUTATING_MCP_ACTION_RE =
  /(?:^|_)(boot|shutdown|erase|reset|install|launch|terminate|kill|tap|swipe|type|press|record|open_url|set_appearance|send)(?:_|$)/iu;

export function isDryRun(command) {
  return /(^|\s)--dry-run(\s|$)/u.test(String(command || ""));
}

/** Pure classification of a Bash command string: "mutating" | "read-only" | "not-simulator". */
export function classifyBashCommand(command) {
  const text = String(command || "");
  // A compound shell command can hide a mutation after a read-only command.
  // Only treat the managed run and dry-run forms as safe when they are alone.
  const isCompound = /[\n;|&`]|\$\(/u.test(text);
  if (!isCompound && /^\s*npm\s+run\s+ios:sim:run\b/u.test(text)) return "not-simulator";
  if (!isCompound && isDryRun(text)) return "read-only";
  if (!isCompound && READ_ONLY_BASH_PATTERNS.some((re) => re.test(text))) return "read-only";
  return MUTATING_BASH_PATTERNS.some((re) => re.test(text)) ? "mutating" : "not-simulator";
}

/** Pure classification of an MCP tool name, e.g. "mcp__ios-simulator__boot_simulator". */
export function classifyMcpTool(toolName, toolInput = {}) {
  const name = String(toolName || "");
  if (!name.startsWith("mcp__") || !/simulator/iu.test(name)) return "not-simulator";
  const action = name.split("__").at(-1) || name;
  if (action === "control") {
    const requestedAction = String(toolInput?.action || "");
    // A generic control tool can mutate simulator state through its action
    // argument. Unknown actions are gated until classified as read-only.
    return /^(list|status|screenshot|get(?:_[a-z0-9]+)+)$/iu.test(requestedAction) ? "read-only" : "mutating";
  }
  return MUTATING_MCP_ACTION_RE.test(action) ? "mutating" : "read-only";
}

export function classifyToolCall(payload) {
  const toolName = payload?.tool_name;
  if (toolName === "Bash") return classifyBashCommand(payload?.tool_input?.command);
  if (typeof toolName === "string" && toolName.startsWith("mcp__")) return classifyMcpTool(toolName, payload?.tool_input);
  return "not-simulator";
}

export function blockReason(lane) {
  return lane === "manual" ? `${ACQUIRE_INSTRUCTION} ${MANUAL_RELEASE_INSTRUCTION}` : ACQUIRE_INSTRUCTION;
}

/** Pure decision: no I/O. `hasLiveLease` is already resolved for the caller's own lane. */
export function evaluateGuard(payload, { lane, hasLiveLease }) {
  if (classifyToolCall(payload) !== "mutating") return { decision: "allow", reason: null };
  if (hasLiveLease) return { decision: "allow", reason: null };
  return { decision: "block", reason: blockReason(lane) };
}

/** I/O: read the current lease state for the caller's own lane. */
export function currentLeaseState(environment = createEnvironment()) {
  const lane = detectLane(environment.env);
  const record = environment.store.load();
  const liveness = leaseLiveness(record.lease, { nowMs: environment.now(), isProcessAlive: environment.isProcessAlive });
  return { lane, hasLiveLease: liveness.live && record.lease?.lane === lane };
}

export function runGuard(input, environment = createEnvironment()) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    // Unparseable hook input never mutates a simulator; failing open here
    // blocks only the guard's own wiring, never simulator use.
    return { decision: "allow", reason: null };
  }
  return evaluateGuard(payload, currentLeaseState(environment));
}

export function formatHookOutput({ decision, reason }) {
  // A neutral result preserves the host's normal permission flow. Returning
  // "allow" here would approve unrelated Bash commands matched by this hook.
  if (decision !== "block") return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
}

function readStdin(stream) {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

async function main() {
  const input = await readStdin(process.stdin);
  const result = runGuard(input);
  process.stdout.write(`${JSON.stringify(formatHookOutput(result))}\n`);
  process.exitCode = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
