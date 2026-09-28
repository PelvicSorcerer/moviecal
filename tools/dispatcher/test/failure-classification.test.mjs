import { describe, it, expect } from "vitest";
import { assessLocalSandboxStartup, classifyWorkerFailure, NESTED_SANDBOX_CRASH } from "../src/failure-classification.mjs";
import { auditWorkerTranscript } from "../src/worker-guard.mjs";
import {
  agentMessage,
  completedCommand,
  jsonl,
  mov399Events,
  nativeFailedEvent,
  nativeStartedEvent,
  SANDBOX_MARKER,
} from "./fixtures/native-sandbox-startup.mjs";

describe("classifyWorkerFailure", () => {
  it("recognizes the nested-sandbox-crash signature: exit 71 + sandbox_apply text", () => {
    const result = classifyWorkerFailure({
      exitCode: 71,
      logTail: "Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted\n",
    });

    expect(result).toEqual({ category: NESTED_SANDBOX_CRASH, signature: "exit-71" });
  });

  it("does not match on exit code 71 alone, without the sandbox_apply text", () => {
    const result = classifyWorkerFailure({ exitCode: 71, logTail: "some unrelated crash output" });

    expect(result).toBeNull();
  });

  it("does not match on the sandbox_apply text alone, with a different exit code", () => {
    const result = classifyWorkerFailure({
      exitCode: 1,
      logTail: "sandbox-exec: sandbox_apply: Operation not permitted",
    });

    expect(result).toBeNull();
  });

  it("recognizes Codex's graceful exit when its structured message reports the signature before tool activity", () => {
    const result = classifyWorkerFailure({
      exitCode: 0,
      logTail: JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Blocked before implementation: sandbox-exec: sandbox_apply: Operation not permitted",
        },
      }),
      toolActions: [],
    });

    expect(result).toEqual({ category: NESTED_SANDBOX_CRASH, signature: "agent-report" });
  });

  it("recognizes the same structured Codex report for a non-71 failure exit", () => {
    const result = classifyWorkerFailure({
      exitCode: 1,
      logTail: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "sandbox_apply: Operation not permitted" },
      }),
      toolActions: [],
    });

    expect(result).toEqual({ category: NESTED_SANDBOX_CRASH, signature: "agent-report" });
  });

  it("does not reclassify a Codex report after an executed tool action", () => {
    const result = classifyWorkerFailure({
      exitCode: 0,
      logTail: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "sandbox_apply: Operation not permitted" },
      }),
      toolActions: [{ kind: "command", value: "rg --files", outcome: "executed" }],
    });

    expect(result).toBeNull();
  });

  it("does not reclassify an arbitrary zero-exit/zero-change result", () => {
    expect(classifyWorkerFailure({ exitCode: 0, logTail: "no files changed", toolActions: [] })).toBeNull();
  });

  it("does not match an ordinary task failure", () => {
    const result = classifyWorkerFailure({ exitCode: 1, logTail: "Error: could not resolve module 'foo'" });

    expect(result).toBeNull();
  });

  it("handles a missing/empty log tail without throwing", () => {
    expect(classifyWorkerFailure({ exitCode: 71, logTail: undefined })).toBeNull();
    expect(classifyWorkerFailure({ exitCode: 71, logTail: "" })).toBeNull();
  });

  it("matches when the signature appears anywhere in a longer tail", () => {
    const result = classifyWorkerFailure({
      exitCode: 71,
      logTail: [
        "--- stdout.log (last 50 lines) ---",
        "$ echo diagnostic",
        "sandbox-exec: sandbox_apply: Operation not permitted",
        "--- stderr.log (last 50 lines) ---",
      ].join("\n"),
    });

    expect(result).toEqual({ category: NESTED_SANDBOX_CRASH, signature: "exit-71" });
  });
});

describe("native Codex sandbox startup failures (MOV-402)", () => {
  const classify = (events, extra = {}) => {
    const transcript = jsonl(events);
    return classifyWorkerFailure({
      exitCode: 0,
      logTail: transcript,
      transcript,
      toolActions: auditWorkerTranscript(transcript).actions,
      ...extra,
    });
  };

  it("recognizes the native failed command event with no model narration and no audit input", () => {
    const transcript = jsonl([nativeStartedEvent, nativeFailedEvent]);
    expect(classifyWorkerFailure({ exitCode: 0, logTail: "", transcript })).toEqual({
      category: NESTED_SANDBOX_CRASH,
      signature: "native-command",
    });
    // Independent of the outer process exit.
    expect(classifyWorkerFailure({ exitCode: 1, logTail: "", transcript })?.signature).toBe("native-command");
  });

  it("classifies the actual MOV-399 shape: agent report + failed native command + audit outcome executed + exit 0", () => {
    const transcript = jsonl(mov399Events());
    const audit = auditWorkerTranscript(transcript);
    // The audit still records the attempt twice, as `executed` (security semantics unchanged).
    expect(audit.actions).toEqual([
      { kind: "command", value: "/bin/zsh -c /bin/pwd", outcome: "executed" },
      { kind: "command", value: "/bin/zsh -c /bin/pwd", outcome: "executed" },
    ]);
    expect(classify(mov399Events())).toEqual({ category: NESTED_SANDBOX_CRASH, signature: "native-command" });
  });

  it("reports health evidence: one startup failure and zero successful local activity, despite duplicate events", () => {
    const events = [nativeStartedEvent, nativeFailedEvent, nativeFailedEvent];
    expect(assessLocalSandboxStartup(jsonl(events))).toEqual({
      startupFailures: [{ command: "/bin/zsh -c /bin/pwd", exitCode: 71 }],
      successfulLocalActivity: 0,
    });
    const duplicateSuccess = completedCommand("item_9", "pwd", { output: "/tmp\n" });
    expect(assessLocalSandboxStartup(jsonl([duplicateSuccess, duplicateSuccess])).successfulLocalActivity).toBe(1);
  });

  it("uses the full transcript, so success outside the log tail still counts", () => {
    const transcript = jsonl([completedCommand("item_1", "pwd", { output: "/tmp\n" }), nativeFailedEvent]);
    const tail = jsonl([nativeFailedEvent]);
    expect(classifyWorkerFailure({ exitCode: 0, logTail: tail, transcript })).toBeNull();
  });

  it("does not recognize a startup failure after successful local activity", () => {
    expect(classify([completedCommand("item_1", "rg --files"), nativeFailedEvent])).toBeNull();
    expect(classify([
      { type: "item.completed", item: { id: "item_1", type: "file_change", changes: [{ path: "src/a.mjs", kind: "update" }], status: "completed" } },
      nativeFailedEvent,
    ])).toBeNull();
  });

  it("does not recognize an agent report after successful local activity", () => {
    expect(classify([
      completedCommand("item_1", "rg --files", { output: "src/a.mjs\n" }),
      agentMessage("item_2", SANDBOX_MARKER),
    ])).toBeNull();
  });

  it("keeps the MOV-299 agent-only report working", () => {
    expect(classify([agentMessage("item_1", `Blocked before implementation: ${SANDBOX_MARKER}`)])).toEqual({
      category: NESTED_SANDBOX_CRASH,
      signature: "agent-report",
    });
  });

  it("does not treat a marker quoted in fetched issue text as a startup failure", () => {
    const quoted = `Evidence from the issue:\n${SANDBOX_MARKER}\nexit 71`;
    expect(classify([
      { type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "codex_apps", tool: "linear.fetch", result: { content: [{ type: "text", text: quoted }] }, status: "completed" } },
    ])).toBeNull();
    expect(classify([completedCommand("item_1", "cat issue.md", { output: quoted })])).toBeNull();
    // Even a failing command whose output merely includes the marker among other text.
    expect(classify([completedCommand("item_1", "grep -q x issue.md; cat issue.md; exit 71", { exitCode: 71, output: quoted })])).toBeNull();
  });

  it("does not treat a generic exit 71, unrelated stderr, or an ordinary nonzero command as a startup failure", () => {
    expect(classify([completedCommand("item_1", "sysexits", { exitCode: 71, output: "internal software error\n" })])).toBeNull();
    expect(classify([completedCommand("item_1", "ls /nope", { exitCode: 1, output: "ls: /nope: Operation not permitted\n" })])).toBeNull();
    expect(classify([completedCommand("item_1", "npm test", { exitCode: 1, output: "1 failed\n" })])).toBeNull();
    // A marker-only output with exit 0 is not a failed startup either.
    expect(classify([completedCommand("item_1", "echo marker", { output: `${SANDBOX_MARKER}\n` })])).toBeNull();
  });
});
