import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { offerJevPatch, createJevPatchTranslator } from "../src/jev-patch.mjs";
import { createResponseObserver } from "../src/openrouter-response.mjs";

describe("fake non-OpenAI Responses patch loop", () => {
  it("accepts the JSON tool call and edits a disposable worktree", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jev-patch-loop-"));
    try {
      fs.writeFileSync(path.join(cwd, "answer.txt"), "before\n");
      const tools = offerJevPatch({ tools: [{ type: "function", name: "exec_command" }] }, "routed").tools;
      const observer = createResponseObserver({ rewriteEvent: createJevPatchTranslator(cwd) });
      observer.setTools(tools);
      const fakeRouterEvent = { type: "response.output_item.done", output_index: 0,
        item: { type: "function_call", name: "apply_patch", call_id: "google-call-1",
          arguments: JSON.stringify({ patch: "*** Begin Patch\n*** Update File: answer.txt\n@@\n-before\n+after\n*** End Patch" }) } };
      const streamed = observer.push(Buffer.from(`data: ${JSON.stringify(fakeRouterEvent)}\n\n`));
      const converted = JSON.parse(streamed.trim().slice("data: ".length));
      expect(converted.item.name).toBe("exec_command");
      const command = JSON.parse(converted.item.arguments);
      execFileSync("zsh", ["-c", command.cmd], { cwd: command.workdir, encoding: "utf8" });
      expect(fs.readFileSync(path.join(cwd, "answer.txt"), "utf8")).toBe("after\n");
      expect(offerJevPatch({ tools: [] }, "control")).toEqual({ tools: [] });
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
