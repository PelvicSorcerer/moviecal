// MOV-387: the unit a worker's per-run budget is counted in. Claude counts
// assistant messages; `codex exec` runs a whole prompt as one turn, so Codex
// counts completed work items instead. The two are not comparable.
export const CLAUDE_BUDGET_UNIT = "claude-assistant-turns";
export const CODEX_BUDGET_UNIT = "codex-items";

/** `item.completed` item types counted as one Codex work item. `reasoning` is excluded: it is emitted alongside steps, not as one. */
export const CODEX_WORK_ITEM_TYPES = Object.freeze(["command_execution", "file_change", "mcp_tool_call", "agent_message"]);

export function budgetUnitForWorker(worker) {
  if (worker === "claude") return CLAUDE_BUDGET_UNIT;
  if (worker === "codex") return CODEX_BUDGET_UNIT;
  return null;
}

export function isCodexWorkItemEvent(event) {
  return event?.type === "item.completed" && CODEX_WORK_ITEM_TYPES.includes(event.item?.type);
}

/** Only Claude with live steering can be sent a wrap-up prompt; Codex has no steering channel. */
export function wrapUpPossible(worker, steeringEnabled) {
  return worker === "claude" && Boolean(steeringEnabled);
}
