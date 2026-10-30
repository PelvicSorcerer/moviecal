import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { offerJevPatch, createJevPatchTranslator } from "../src/jev-patch.mjs";
import { createResponseObserver } from "../src/openrouter-response.mjs";

// Codex's apply_patch executable exists only inside its executor, so a stub on
// PATH records exactly what the translated command delivers on stdin.
function run(patch, cwd, bin) {
  const tools = offerJevPatch({ tools: [{ type: "function", name: "exec_command" }] }, "routed").tools;
  const observer = createResponseObserver({ rewriteEvent: createJevPatchTranslator(cwd) });
  observer.setTools(tools);
  const fakeRouterEvent = { type: "response.output_item.done", output_index: 0,
    item: { type: "function_call", name: "apply_patch", call_id: "google-call-1", arguments: JSON.stringify({ patch }) } };
  const streamed = observer.push(Buffer.from(`data: ${JSON.stringify(fakeRouterEvent)}\n\n`));
  const converted = JSON.parse(streamed.trim().slice("data: ".length));
  expect(converted.item.name).toBe("exec_command");
  const command = JSON.parse(converted.item.arguments);
  execFileSync("sh", ["-c", command.cmd], { cwd: command.workdir, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
}

describe("fake non-OpenAI Responses patch loop", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jev-patch-loop-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "jev-patch-bin-"));
  fs.writeFileSync(path.join(bin, "apply_patch"), "#!/bin/sh\ncat > \"$PWD/received.patch\"\n", { mode: 0o755 });

  it("delivers the JSON tool call to apply_patch unchanged", () => {
    const patch = "*** Begin Patch\n*** Update File: answer.txt\n@@\n-before\n+after\n*** End Patch";
    run(patch, cwd, bin);
    expect(fs.readFileSync(path.join(cwd, "received.patch"), "utf8")).toBe(`${patch}\n`);
  });

  it("cannot be cut short by a patch line that looks like the here-document marker", () => {
    const patch = "*** Begin Patch\n*** Add File: note.txt\n+x\n+MOVIECAL_JEV_PATCH\n*** End Patch";
    run(patch, cwd, bin);
    expect(fs.readFileSync(path.join(cwd, "received.patch"), "utf8")).toBe(`${patch}\n`);
    // Even a body line equal to the bare marker is carried through whole.
    const bare = "*** Begin Patch\n*** Add File: note.txt\nMOVIECAL_JEV_PATCH\n; touch pwned\n*** End Patch";
    run(bare, cwd, bin);
    expect(fs.readFileSync(path.join(cwd, "received.patch"), "utf8")).toBe(`${bare}\n`);
    expect(fs.existsSync(path.join(cwd, "pwned"))).toBe(false);
  });

  it("leaves the fixed control request and tool set untouched", () => {
    const body = { tools: [{ type: "function", name: "exec_command" }] };
    expect(offerJevPatch(body, "control")).toBe(body);
    expect(offerJevPatch(body, "control").tools.some((tool) => tool.name === "apply_patch")).toBe(false);
  });
});
