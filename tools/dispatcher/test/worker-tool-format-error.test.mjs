import { describe, expect, it } from "vitest";
import { countToolFormatErrors } from "../src/worker-tool-format-error.mjs";

const PARSE = 'failed to parse function arguments: invalid type: string "false", expected a boolean at line 1 column 40';
describe("worker tool format errors", () => {
  it("counts Codex tool-router parse errors returned as tool outputs", () => {
    expect(countToolFormatErrors([
      { type: "function_call_output", call_id: "a", output: PARSE },
      { type: "custom_tool_call_output", call_id: "b", output: ` ${PARSE}\n` },
      { type: "function_call_output", call_id: "c", output: "ok" },
    ])).toBe(2);
  });
  it("ignores model messages that merely quote the text, non-string outputs and non-arrays", () => {
    expect(countToolFormatErrors([{ type: "message", role: "assistant", content: PARSE },
      { type: "function_call_output", call_id: "a", output: `I saw: ${PARSE}` },
      { type: "function_call_output", call_id: "b", output: { text: PARSE } }])).toBe(0);
    expect(countToolFormatErrors(undefined)).toBe(0);
  });
});
