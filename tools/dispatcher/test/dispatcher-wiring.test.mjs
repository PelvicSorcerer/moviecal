import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// bin/dispatcher.mjs calls main() at module load, so it can't be imported for
// unit testing. These are structural guards on the wiring that the promoter
// (MOV-129) depends on: a promote pass must run every cycle, before the
// dispatch scan reads "Ready for Agent", and it must not be able to abort
// dispatch.
const source = readFileSync(
  fileURLToPath(new URL("../bin/dispatcher.mjs", import.meta.url)),
  "utf8",
);

function bodyOf(fnName) {
  const start = source.indexOf(`async function ${fnName}(`);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  // crude brace match from the first "{" after the signature
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`could not find end of ${fnName}`);
}

describe("dispatcher run-loop wiring (MOV-129)", () => {
  it("cmdRunOnce awaits a promote pass before reading Ready for Agent", () => {
    const body = bodyOf("cmdRunOnce");
    const promoteAt = body.indexOf("promotePass(");
    const dispatchReadAt = body.indexOf("issuesInState(");
    expect(promoteAt, "promotePass() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(dispatchReadAt, "issuesInState() not called in cmdRunOnce").toBeGreaterThan(-1);
    expect(promoteAt).toBeLessThan(dispatchReadAt);
    expect(body).toMatch(/await\s+promotePass\(\)/);
  });

  it("promotePass swallows errors so a promote failure cannot abort dispatch", () => {
    const body = bodyOf("promotePass");
    expect(body).toMatch(/try\s*\{/);
    expect(body).toMatch(/catch/);
    expect(body).toMatch(/cmdPromoteOnce/);
  });
});
