import { describe, it, expect } from "vitest";
import { classifyWorkerFailure, NESTED_SANDBOX_CRASH } from "../src/failure-classification.mjs";

describe("classifyWorkerFailure", () => {
  it("recognizes the nested-sandbox-crash signature: exit 71 + sandbox_apply text", () => {
    const result = classifyWorkerFailure({
      exitCode: 71,
      logTail: "Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted\n",
    });

    expect(result).toEqual({ category: NESTED_SANDBOX_CRASH });
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

    expect(result).toEqual({ category: NESTED_SANDBOX_CRASH });
  });
});
