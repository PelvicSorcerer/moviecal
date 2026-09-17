import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function structuredMarkers(issueTemplate: string, prTemplate: string) {
  return {
    issue: /^## Manual Verification$/m.test(issueTemplate)
      && /^Human testing:/m.test(issueTemplate),
    pr: /^## Readiness Evidence$/m.test(prTemplate)
      && /^Human testing:/m.test(prTemplate),
  };
}

describe("testing governance structured readiness markers", () => {
  it("accepts the repository templates", () => {
    const result = structuredMarkers(
      readFileSync(".github/ISSUE_TEMPLATE/agent_task.md", "utf8"),
      readFileSync(".github/pull_request_template.md", "utf8"),
    );
    expect(result).toEqual({ issue: true, pr: true });
  });

  it("rejects an issue template without the human-testing marker", () => {
    expect(structuredMarkers("## Manual Verification", "## Readiness Evidence\nHuman testing: required").issue).toBe(false);
  });

  it("rejects a PR template without readiness evidence", () => {
    expect(structuredMarkers("## Manual Verification\nHuman testing: required", "Human testing: required").pr).toBe(false);
  });
});
