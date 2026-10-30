// Codex's own tool router rejects a model's tool call when an argument has the
// wrong JSON type (for example the string "false" where a boolean is expected)
// and returns that text to the model as the tool output. That is a bad model
// output, not a routing or safety fault, so it is counted as a failed attempt
// and never stops the cohort. Arguments are never coerced.
const SIGNATURE = /^failed to parse function arguments: invalid type: /;

/** Count tool outputs in a Responses request input that carry the router's parse error. */
export function countToolFormatErrors(input) {
  if (!Array.isArray(input)) return 0;
  return input.filter((item) => ["function_call_output", "custom_tool_call_output"].includes(item?.type)
    && typeof item.output === "string" && SIGNATURE.test(item.output.trim())).length;
}
