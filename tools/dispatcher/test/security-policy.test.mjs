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

  it("hard-denies any worker push because remote publication is dispatcher-only", () => {
    expect(classifyAction("git push origin agent/MOV-1-fix").verdict).toBe("hard-deny");
  });

  it.each(["git status", "command git diff", "xcrun git show HEAD"])("hard-denies every worker Git invocation: %s", (command) => {
    expect(classifyAction(command).verdict).toBe("hard-deny");
  });

  it.each([
    "/usr/bin/git -c credential.helper=osxkeychain push origin agent/MOV-1-fix",
    "g'i't push origin master",
    "gh api -X PUT repos/owner/repo/rulesets/1 --input payload.json",
    "gh api repos/owner/repo/actions/secrets/NAME -X PUT --input body.json",
    "curl -X DELETE https://api.github.com/repos/owner/repo/git/refs/heads/master",
    "ssh git@github.com git-receive-pack owner/repo.git",
  ])("hard-denies adversarial or alternate GitHub mutation path: %s", (command) => {
    expect(classifyAction(command).verdict).toBe("hard-deny");
  });

  it("keeps even read-only GitHub CLI calls in the dispatcher", () => {
    expect(classifyAction("gh pr view 42 --json title").verdict).toBe("hard-deny");
  });

  // MOV-174: /usr/bin/security is no longer denied at the sandbox-exec level
  // (Claude Code's own startup Keychain probe needs it), so this audit is now
  // the only backstop against a worker reading Keychain secrets itself.
  it.each([
    'security find-generic-password -a user -w -s "iCloud"',
    "security dump-keychain",
    "security export-keychain",
  ])("hard-denies a worker invoking keychain access directly: %s", (command) => {
    expect(classifyAction(command).verdict).toBe("hard-deny");
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

  it.each([
    "edit test/auth.test.ts",
    "edit docs/operators/local-execution.md",
    "edit tools/dispatcher/src/security-policy.mjs",
    "edit package.json",
  ])("hard-denies repair workers changing tests or governance: %s", (action) => {
    expect(classifyAction(action, { workerMode: "repair" }).verdict).toBe("hard-deny");
    expect(classifyAction(action, { workerMode: "implementation" }).verdict).not.toBe("hard-deny");
  });
});
