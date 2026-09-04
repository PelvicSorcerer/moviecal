import { describe, it, expect } from "vitest";
import { classifyAction } from "../src/security-policy.mjs";

describe("classifyAction", () => {
  it("allows an ordinary command", () => {
    expect(classifyAction("npm run verify")).toEqual({ verdict: "allow", reason: null });
  });

  it("hard-denies a force-push", () => {
    expect(classifyAction("git push --force origin agent/MOV-1-fix").verdict).toBe("hard-deny");
  });

  it("hard-denies a push to master", () => {
    expect(classifyAction("git push origin master").verdict).toBe("hard-deny");
  });

  it("does not flag pushing a feature branch", () => {
    expect(classifyAction("git push origin agent/MOV-1-fix").verdict).toBe("allow");
  });

  it("hard-denies editing a workflow file", () => {
    expect(classifyAction("edit .github/workflows/verify.yml").verdict).toBe("hard-deny");
  });

  it("hard-denies gh secret set", () => {
    expect(classifyAction("gh secret set FOO --body bar").verdict).toBe("hard-deny");
  });

  it("hard-denies echoing a credential-shaped variable", () => {
    expect(classifyAction("echo $SUPABASE_SERVICE_ROLE_KEY").verdict).toBe("hard-deny");
  });

  it("hard-denies any reference to the production DB URL", () => {
    expect(classifyAction("psql $SUPABASE_DB_URL_PROD").verdict).toBe("hard-deny");
  });

  it("hard-denies npm publish", () => {
    expect(classifyAction("npm publish").verdict).toBe("hard-deny");
  });

  it("hard-denies editing AGENTS.md", () => {
    expect(classifyAction("edit AGENTS.md").verdict).toBe("hard-deny");
  });

  it("flags a database migration as needs-human", () => {
    expect(classifyAction("edit supabase/migrations/0042_add_column.sql").verdict).toBe("needs-human");
  });

  it("flags auth route changes as needs-human", () => {
    expect(classifyAction("edit src/app/auth/sign-in/route.ts").verdict).toBe("needs-human");
  });
});
