// MOV-403: positive evidence that an adapter's own local tool sandbox works.
//
// A clean worker exit is not proof: Codex can narrate a failed first command
// and exit 0 (MOV-399/MOV-402), and a successful Claude run says nothing about
// Codex's nested command sandbox (MOV-401). The nested-sandbox breaker closes
// only when the affected adapter's structured transcript shows a local
// command that actually completed successfully.

import fs from "node:fs";
import path from "node:path";

const SANDBOX_FAILURE = /sandbox_apply|operation not permitted|permission denied/i;

function text(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function codexEvidence(event) {
  const item = event?.type === "item.completed" ? event.item : null;
  if (item?.type !== "command_execution" || typeof item.command !== "string") return null;
  const exitCode = item.exit_code ?? item.exitCode;
  if (exitCode !== 0) return null;
  if (item.status && String(item.status).toLowerCase() !== "completed") return null;
  if (SANDBOX_FAILURE.test(text(item.aggregated_output))) return null;
  return `codex command_execution exited 0: ${item.command.slice(0, 160)}`;
}

/**
 * Find the first successful local command run by `adapter` in a structured
 * transcript. Returns an evidence string, or null when there is none.
 */
export function localToolSuccessEvidence(transcript, adapter) {
  const bashCalls = new Map();
  for (const line of String(transcript || "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (adapter === "codex") {
      const evidence = codexEvidence(event);
      if (evidence) return evidence;
      continue;
    }
    if (adapter !== "claude") continue;
    const content = event?.message?.content;
    for (const value of Array.isArray(content) ? content : []) {
      if (value?.type === "tool_use" && value.name === "Bash" && typeof value.input?.command === "string" && value.id) {
        bashCalls.set(value.id, value.input.command);
      }
      if (value?.type === "tool_result" && bashCalls.has(value.tool_use_id)) {
        if (value.is_error === true || SANDBOX_FAILURE.test(text(value.content))) continue;
        return `claude Bash tool result succeeded: ${bashCalls.get(value.tool_use_id).slice(0, 160)}`;
      }
    }
  }
  return null;
}

/** Read `<logDir>/stdout.log`; a missing or unreadable transcript is no evidence. */
export function readLocalToolSuccessEvidence(logDir, adapter, { fsImpl = fs } = {}) {
  try {
    return localToolSuccessEvidence(fsImpl.readFileSync(path.join(logDir || "", "stdout.log"), "utf8"), adapter);
  } catch {
    return null;
  }
}
