import { describe, it, expect, vi } from "vitest";
import { CLAUDE_WORKER_TOOLS } from "../src/worker-routing.mjs";
import {
  describeClaudeStartupCheck, evaluateClaudeInit, isClaudeInitEvent, reportClaudeStartupCheck,
} from "../src/worker-startup-check.mjs";
import { makeInitEventWatcher } from "../src/worker-spawn.mjs";

const init = (overrides = {}) => ({
  type: "system", subtype: "init", permissionMode: "dontAsk", tools: [...CLAUDE_WORKER_TOOLS], claude_code_version: "2.1.281", ...overrides,
});

describe("evaluateClaudeInit (MOV-386)", () => {
  it("matches dontAsk with exactly the allowlisted tools", () => {
    expect(evaluateClaudeInit(init())).toEqual({
      status: "match",
      permissionMode: "dontAsk",
      expectedPermissionMode: "dontAsk",
      tools: [...CLAUDE_WORKER_TOOLS],
      expectedTools: [...CLAUDE_WORKER_TOOLS],
      unexpectedTools: [],
      missingTools: [],
      cliVersion: "2.1.281",
      problems: [],
    });
  });

  it("flags the scrub-forced default mode", () => {
    const check = evaluateClaudeInit(init({ permissionMode: "default" }));
    expect(check).toMatchObject({ status: "mismatch", permissionMode: "default", unexpectedTools: [] });
    expect(check.problems).toEqual(['permissionMode is "default", expected "dontAsk"']);
  });

  it("flags every tool outside the allowlist, including MCP tools", () => {
    const check = evaluateClaudeInit(init({ tools: [...CLAUDE_WORKER_TOOLS, "Workflow", "WebSearch", "mcp__server__tool"] }));
    expect(check).toMatchObject({ status: "mismatch", unexpectedTools: ["Workflow", "WebSearch", "mcp__server__tool"] });
    expect(check.problems).toEqual(["tools outside the allowlist: Workflow, WebSearch, mcp__server__tool"]);
  });

  it("reports both problems together, and bounds odd tool names instead of dropping them", () => {
    const check = evaluateClaudeInit(init({ permissionMode: "bypassPermissions", tools: ["Read", "Evil Tool!"] }));
    expect(check.status).toBe("mismatch");
    expect(check.unexpectedTools).toEqual(["Evil_Tool_"]);
    expect(check.problems).toHaveLength(2);
  });

  it("lists allowlisted tools the CLI did not load without treating that as a mismatch", () => {
    const check = evaluateClaudeInit(init({ tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"] }));
    expect(check).toMatchObject({ status: "match", missingTools: ["NotebookEdit", "Task"] });
  });

  it("treats an absent mode or tools list as a mismatch", () => {
    expect(evaluateClaudeInit(init({ permissionMode: undefined })).problems).toEqual(['permissionMode is absent, expected "dontAsk"']);
    expect(evaluateClaudeInit(init({ tools: undefined }))).toMatchObject({ status: "mismatch", tools: null, problems: ["the init event carried no tools list"] });
  });

  it("reports a missing init event as missing, not as a match", () => {
    for (const event of [null, undefined, { type: "assistant" }, { type: "system", subtype: "compact_boundary" }]) {
      expect(isClaudeInitEvent(event)).toBe(false);
      expect(evaluateClaudeInit(event)).toMatchObject({ status: "missing", permissionMode: null, tools: null, problems: ["no system/init event was observed"] });
    }
  });
});

describe("reportClaudeStartupCheck (MOV-386)", () => {
  it("logs a loud warning naming the problem on mismatch", () => {
    const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
    expect(reportClaudeStartupCheck(evaluateClaudeInit(init({ permissionMode: "default" })), { label: "MOV-1", logger })).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^WARNING \(MOV-386\): Claude worker for MOV-1 did not start as configured — permissionMode is "default"/));
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("falls back to logger.error when the logger has no warn", () => {
    const logger = { error: vi.fn() };
    reportClaudeStartupCheck(evaluateClaudeInit(init({ tools: ["Workflow"] })), { label: "MOV-2", logger });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("tools outside the allowlist: Workflow"));
  });

  it("logs one quiet confirmation on a match", () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    expect(reportClaudeStartupCheck(evaluateClaudeInit(init()), { label: "MOV-3", logger })).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith("Claude worker for MOV-3 started in dontAsk mode with the allowlisted tools only.");
  });
});

describe("makeInitEventWatcher (MOV-386)", () => {
  it("fires once for the first init event, across chunk boundaries", () => {
    const onInit = vi.fn();
    const watch = makeInitEventWatcher(onInit);
    const text = [JSON.stringify({ type: "assistant" }), "not json", JSON.stringify(init()), JSON.stringify(init({ permissionMode: "default" }))].join("\n") + "\n";
    watch(Buffer.from(text.slice(0, 40)));
    watch(Buffer.from(text.slice(40)));
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onInit.mock.calls[0][0].permissionMode).toBe("dontAsk");
  });
});

describe("describeClaudeStartupCheck — doctor rendering (MOV-386)", () => {
  const run = (issue, event, extra = {}) => ({ issue, worker: "claude", startedAt: "2026-09-26T10:00:00.000Z", startupCheck: evaluateClaudeInit(event), ...extra });

  it("reports that nothing has been observed yet", () => {
    expect(describeClaudeStartupCheck([{ worker: "codex", startupCheck: null }, { worker: "claude" }])).toEqual({
      name: "Claude worker startup mode and tools",
      ok: true,
      detail: expect.stringMatching(/^no Claude worker run with a recorded startup check yet/),
    });
  });

  it("passes with the last observed mode, tools and CLI version", () => {
    const result = describeClaudeStartupCheck([run("MOV-10", init())]);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe(
      "matches — last observed MOV-10 at 2026-09-26T10:00:00.000Z, Claude Code 2.1.281: mode dontAsk; tools Read, Edit, Write, Glob, Grep, Bash, NotebookEdit, Task.",
    );
  });

  it("fails on a recorded mismatch and names what differed", () => {
    const result = describeClaudeStartupCheck([run("MOV-10", init()), run("MOV-11", init({ permissionMode: "default", tools: ["Read", "Workflow"] }))]);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^MISMATCH — permissionMode is "default", expected "dontAsk"; tools outside the allowlist: Workflow\. Last observed MOV-11/);
    expect(result.detail).toContain("mode default; tools Read, Workflow");
  });

  it("uses the last observed run and calls out a newer run with no init event", () => {
    const result = describeClaudeStartupCheck([run("MOV-10", init()), run("MOV-12", null)]);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/^matches — last observed MOV-10/);
    expect(result.detail).toMatch(/Latest run MOV-12 emitted no system\/init event/);
  });

  it("does not claim a match when no run ever emitted an init event", () => {
    const result = describeClaudeStartupCheck([run("MOV-12", null)]);
    expect(result).toMatchObject({ ok: true, detail: expect.stringMatching(/^no Claude run has emitted a system\/init event yet/) });
  });
});
