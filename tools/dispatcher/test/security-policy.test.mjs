import { describe, it, expect } from "vitest";
import { COMMAND_RULES, PATH_RULES, classifyAction } from "../src/security-policy.mjs";

describe("classifyAction", () => {
  it("allows an ordinary command", () => {
    expect(classifyAction("npm run verify")).toEqual({ verdict: "allow", reason: null, category: null });
  });

  it("requires an explicit scope or safety category on every policy rule", () => {
    expect([...COMMAND_RULES, ...PATH_RULES].every((rule) => ["scope", "safety"].includes(rule.category))).toBe(true);
    expect(classifyAction("git status").category).toBe("scope");
    expect(classifyAction("gh pr view 42 --json title").category).toBe("scope");
    expect(classifyAction("gh secret set FOO --body bar").category).toBe("safety");
    expect(classifyAction("security dump-keychain").category).toBe("safety");
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

  it.each([
    'grep -n "EPERM\\|git exec\\|sandbox-exec coverage" docs/planning/testing-lanes.md 2>/dev/null',
    'grep -n "foo\\|git" docs/planning/testing-lanes.md',
  ])("allows escaped regular-expression text that merely spells git: %s", (command) => {
    expect(classifyAction(command)).toEqual({ verdict: "allow", reason: null, category: null });
  });

  it("still hard-denies Git after a real no-whitespace pipeline", () => {
    expect(classifyAction("printf source|git hash-object --stdin").verdict).toBe("hard-deny");
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

  it.each([
    "npm run lane:unit -- tools/dispatcher/test/credential-failure.test.mjs",
    "npm run credential-contract-test",
  ])("allows local npm run commands whose names or test paths mention credentials: %s", (command) => {
    expect(classifyAction(command)).toEqual({ verdict: "allow", reason: null, category: null });
  });

  it.each([
    "npm token create",
    "npm config set credential helper",
    "npm run verify; npm token create",
  ])("continues to hard-deny npm credential operations: %s", (command) => {
    expect(classifyAction(command).verdict).toBe("hard-deny");
  });

  it("does not treat a later grep pattern as an echo of a credential", () => {
    expect(classifyAction('echo ---; grep -rln "ANTHROPIC_API_KEY\\|anthropic" tools/dispatcher/src')).toEqual({ verdict: "allow", reason: null, category: null });
    expect(classifyAction("echo $ANTHROPIC_API_KEY").verdict).toBe("hard-deny");
  });

  it.each([
    "cat AGENTS.md",
    "head -50 AGENTS.md",
    "sed -n '1,50p' AGENTS.md",
    "rg -n worker AGENTS.md",
    "ls docs/governance/ 2>/dev/null | head -20; echo ---; cat AGENTS.md 2>/dev/null | head -50",
    'find . -maxdepth 3 -newer AGENTS.md -not -path "./node_modules/*" -not -path "./.git/*" -type f',
    "find . -name AGENTS.md",
    "find . -anewer AGENTS.md -type f",
  ])("allows read-only protected-path orientation: %s", (command) => {
    expect(classifyAction(command)).toEqual({ verdict: "allow", reason: null, category: null });
  });

  it.each([
    "edit AGENTS.md",
    "cp README.md AGENTS.md",
    "cat README.md > AGENTS.md",
    "printf replacement > AGENTS.md",
    "echo replacement >> AGENTS.md",
    "sed -i 's/old/new/' AGENTS.md",
    "sed -ni 's/old/new/' AGENTS.md",
    "sh -c 'echo replacement > AGENTS.md'",
    "find . -name AGENTS.md -exec sed -i s/old/new/ {} +",
    "find . -name AGENTS.md -delete",
    "find . -newer AGENTS.md -fprintf AGENTS.md %p",
  ])("hard-denies direct or shell-mediated writes to AGENTS.md: %s", (command) => {
    expect(classifyAction(command).verdict).toBe("hard-deny");
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
