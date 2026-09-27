import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localToolSuccessEvidence, readLocalToolSuccessEvidence } from "../src/sandbox-recovery.mjs";

const lines = (...events) => events.map((event) => JSON.stringify(event)).join("\n");
const codexCommand = (item) => ({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "bash -lc ls", aggregated_output: "", ...item } });
const claudeCall = (id = "t1") => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "git status" } }] } });
const claudeResult = (result, id = "t1") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...result }] } });

describe("localToolSuccessEvidence (MOV-403)", () => {
  it("accepts a completed codex command that exited 0", () => {
    expect(localToolSuccessEvidence(lines(codexCommand({ exit_code: 0, status: "completed" })), "codex")).toContain("bash -lc ls");
  });

  it.each([
    ["a non-zero exit", { exit_code: 1, status: "failed" }],
    ["a missing exit code", { status: "completed" }],
    ["a declined command", { exit_code: 0, status: "declined" }],
    ["a sandbox refusal in the output", { exit_code: 0, status: "completed", aggregated_output: "sandbox_apply: Operation not permitted" }],
  ])("rejects codex %s", (_label, item) => {
    expect(localToolSuccessEvidence(lines(codexCommand(item)), "codex")).toBeNull();
  });

  it("rejects a clean exit that only narrates, with no command", () => {
    const transcript = lines({ type: "item.completed", item: { type: "agent_message", text: "Done, no changes needed." } });
    expect(localToolSuccessEvidence(transcript, "codex")).toBeNull();
  });

  it("accepts a successful claude Bash tool result", () => {
    expect(localToolSuccessEvidence(lines(claudeCall(), claudeResult({ is_error: false, content: "clean" })), "claude")).toContain("git status");
  });

  it("rejects claude errors and sandbox denials", () => {
    expect(localToolSuccessEvidence(lines(claudeCall(), claudeResult({ is_error: true, content: "Exit code 1" })), "claude")).toBeNull();
    expect(localToolSuccessEvidence(lines(claudeCall(), claudeResult({ content: "sandbox_apply: Operation not permitted" })), "claude")).toBeNull();
  });

  it("never accepts another adapter's success", () => {
    expect(localToolSuccessEvidence(lines(codexCommand({ exit_code: 0, status: "completed" })), "claude")).toBeNull();
    expect(localToolSuccessEvidence(lines(claudeCall(), claudeResult({ content: "ok" })), "codex")).toBeNull();
  });

  it("treats a missing transcript as no evidence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moviecal-sandbox-recovery-"));
    try {
      expect(readLocalToolSuccessEvidence(dir, "codex")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
