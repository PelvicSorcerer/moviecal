import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { offerJevPatch, patchCommand, createJevPatchTranslator } from "../src/jev-patch.mjs";

describe("Jev patch function", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-patch-test-"));
  const patch = "*** Begin Patch\n*** Add File: answer.txt\n+after\n*** End Patch";

  it("offers a strict JSON function only to the Jev arm", () => {
    const body = { tools: [{ type: "function", name: "exec_command" }] };
    expect(offerJevPatch(body, "control")).toBe(body);
    const offered = offerJevPatch(body, "routed").tools.at(-1);
    expect(offered).toMatchObject({ type: "function", name: "apply_patch",
      parameters: { required: ["patch"], additionalProperties: false } });
  });

  it("translates a non-OpenAI call to the contained executor", () => {
    const translator = createJevPatchTranslator(root);
    expect(translator({ type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", name: "apply_patch" } })).toBeNull();
    expect(translator({ type: "response.function_call_arguments.delta", output_index: 0, delta: "partial" })).toBeNull();
    const converted = translator({ type: "response.output_item.done", output_index: 0,
      item: { type: "function_call", name: "apply_patch", call_id: "call-1", arguments: JSON.stringify({ patch }) } });
    expect(converted.item.name).toBe("exec_command");
    expect(JSON.parse(converted.item.arguments)).toMatchObject({ workdir: root, login: false,
      cmd: expect.stringContaining("apply_patch <<") });
  });

  it.each([
    ["not-json", "invalid JSON"],
    [JSON.stringify({ patch: "bad" }), "expected one complete patch"],
    [JSON.stringify({ patch: "*** Begin Patch\n*** Add File: ../outside\n+bad\n*** End Patch" }), "path is outside the worktree"],
    [JSON.stringify({ patch: "*** Begin Patch\n*** Add File: .git/config\n+bad\n*** End Patch" }), "protected patch path"],
  ])("returns a retryable tool error for invalid call %s", (args, message) => {
    expect(patchCommand(args, root).cmd).toContain(`Patch error: ${message}`);
  });

  it("rejects a symlink escape", () => {
    fs.symlinkSync(os.tmpdir(), path.join(root, "escape"));
    const args = JSON.stringify({ patch: "*** Begin Patch\n*** Add File: escape/outside\n+bad\n*** End Patch" });
    expect(patchCommand(args, root).cmd).toContain("path resolves outside the worktree");
  });
});
