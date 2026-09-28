// MOV-402: the retained MOV-399 Codex transcript shape (third run,
// 2026-09-27), trimmed to the events that matter. The remote Linear fetch
// result and agent narration are shortened; the command events are verbatim.

export const SANDBOX_MARKER = "sandbox-exec: sandbox_apply: Operation not permitted";

export const nativeStartedEvent = {
  type: "item.started",
  item: { id: "item_3", type: "command_execution", command: "/bin/zsh -c /bin/pwd", aggregated_output: "", exit_code: null, status: "in_progress" },
};

export const nativeFailedEvent = {
  type: "item.completed",
  item: { id: "item_3", type: "command_execution", command: "/bin/zsh -c /bin/pwd", aggregated_output: `${SANDBOX_MARKER}\n`, exit_code: 71, status: "failed" },
};

export function agentMessage(id, text) {
  return { type: "item.completed", item: { id, type: "agent_message", text } };
}

export function completedCommand(id, command, { exitCode = 0, output = "" } = {}) {
  return {
    type: "item.completed",
    item: { id, type: "command_execution", command, aggregated_output: output, exit_code: exitCode, status: exitCode === 0 ? "completed" : "failed" },
  };
}

export function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** Agent report + remote fetch + failed native command (started and completed) + closing report. */
export function mov399Events() {
  return [
    { type: "thread.started", thread_id: "01a0e52a-b1d2-7161-b324-e9ab1734669f" },
    { type: "turn.started" },
    agentMessage("item_0", "I'll trace the command classifier and add focused regression coverage."),
    agentMessage("item_1", "The first repository read was blocked before the shell started: the sandbox returned `sandbox_apply: Operation not permitted`."),
    { type: "item.started", item: { id: "item_2", type: "mcp_tool_call", server: "codex_apps", tool: "linear.fetch", arguments: { id: "issue:MOV-399" }, result: null, error: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "codex_apps", tool: "linear.fetch", arguments: { id: "issue:MOV-399" }, result: { content: [{ type: "text", text: "{\"id\":\"MOV-399\"}" }] }, error: null, status: "completed" } },
    nativeStartedEvent,
    nativeFailedEvent,
    agentMessage("item_4", `The local shell could not start: even a read-only \`pwd\` returned \`${SANDBOX_MARKER}\`. I made no filesystem changes.`),
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
}
