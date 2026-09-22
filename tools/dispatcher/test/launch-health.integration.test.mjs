// Integration seam: the launch check receives an actual child-process-shaped
// GitHub CLI failure and refuses it before any dispatcher PR path can use it.
import { describe, it, expect } from "vitest";
import { checkGithubCliAuth } from "../src/launch-health.mjs";

describe("dispatcher startup GitHub CLI failure (MOV-287)", () => {
  it("fails closed for a mocked gh 401 without exposing the child output", () => {
    const result = checkGithubCliAuth({
      run: () => {
        const error = new Error("Command failed: gh auth status");
        error.status = 1;
        error.stderr = "HTTP 401: Requires authentication\\naccess_token=not-for-logs";
        throw error;
      },
    });
    expect(result).toMatchObject({ ok: false, kind: "gh-auth-unavailable" });
    expect(JSON.stringify(result)).not.toContain("not-for-logs");
  });
});
