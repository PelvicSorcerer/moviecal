import { describe, it, expect } from "vitest";
import { classifyAction, shellView } from "../src/security-policy.mjs";

// MOV-398: commands that blocked publication in error, and the controls that
// must stay fail-closed. Add every future false positive to FALSE_POSITIVES
// with the reason it was blocked under, and a matching control when the fix
// narrows a rule. Protected-path reads and writes (MOV-400) have their own
// pair of lists below.

// Reconstructed from the audit records of the four issues parked in
// Needs Human Decision on master at 4e17355. None changed a protected path.
const HEREDOC_FALSE_POSITIVES = [
  {
    issue: "MOV-341",
    blockedAs: "secret or credential mutation/access",
    command: `cat > test/shared-list-create-rename.integration.test.ts <<'EOF'
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const resolveAuthTokensWithClient = vi.fn();
vi.mock("@/lib/auth/resolve-auth-tokens", () => ({ resolveAuthTokensWithClient }));

describe("POST /api/v1/shared-lists", () => {
  beforeEach(() => {
    resolveAuthTokensWithClient.mockResolvedValue({ accessToken: "test-token", refreshToken: null });
  });

  it("rejects a request without a bearer token", async () => {
    const response = await POST(new Request("http://localhost/api/v1/shared-lists", { method: "POST" }));
    expect(response.status).toBe(401);
  });
});
EOF`,
  },
  {
    issue: "MOV-342",
    blockedAs: "secret or credential mutation/access",
    command: `cat > test/shared-list-delete.integration.test.ts <<'EOF'
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

vi.mock("@/lib/auth/resolve-auth-tokens", () => ({
  resolveAuthTokensWithClient: vi.fn(async () => ({ accessToken: "owner-token" })),
}));

describe("DELETE /api/v1/shared-lists/:id", () => {
  it("lets only the owner delete with a bearer token", async () => {
    const client = createClient("http://localhost:54321", "anon-key");
    expect(client).toBeDefined();
  });
});
EOF`,
  },
  {
    issue: "MOV-333",
    blockedAs: "secret or credential mutation/access",
    command: `mkdir -p "src/app/api/shared-lists/[id]/members/[memberId]" && cat > "src/app/api/shared-lists/[id]/members/[memberId]/route.ts" <<'EOF'
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\\s+/i, "");
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, memberId } = await params;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: \`Bearer \${token}\` } },
  });
  const { error } = await supabase.rpc("remove_shared_list_member", { list_id: id, member_id: memberId });
  return error ? NextResponse.json({ error: error.message }, { status: 403 }) : new NextResponse(null, { status: 204 });
}
EOF`,
  },
  {
    issue: "MOV-388",
    blockedAs: "edits worker permission policy",
    command: `python3 - <<'E'
from pathlib import Path
path = Path("tools/dispatcher/src/brief.mjs")
source = path.read_text()
source = source.replace(
    "delegate to the repo's \`explore\` subagent",
    "delegate to the repo's \`explore\` subagent in .claude/agents/ when the worker has the Task tool",
)
path.write_text(source)
E`,
  },
];

// Earlier false positives, fixed by narrower rules before MOV-398. Kept here
// so the corpus is the one place that lists them all.
const EARLIER_FALSE_POSITIVES = [
  ["MOV-239", "cat AGENTS.md 2>/dev/null | head -50"],
  ["MOV-244", 'grep -n "EPERM\\|git exec\\|sandbox-exec coverage" docs/planning/testing-lanes.md 2>/dev/null'],
  ["MOV-368", 'rg -n -E "fast follow|testflight" docs README.md AGENTS.md .github .claude tools 2>/dev/null | grep -v "/archive/"'],
  ["npm run credential paths", "npm run lane:unit -- tools/dispatcher/test/credential-failure.test.mjs"],
];

// Exact read commands from the six historical security-audit.json records
// named by MOV-399, with duplicate transcript events removed.
const MIGRATION_READS = [
  [
    "MOV-330",
    "ls && echo \"--- supabase ---\" && ls supabase/migrations/ && echo \"--- pkg scripts ---\" && node -e \"const p=require('./package.json');console.log(JSON.stringify(p.scripts,null,1))\""
  ],
  [
    "MOV-330",
    "ls && echo \"--- supabase ---\" && ls supabase/migrations/"
  ],
  [
    "MOV-330",
    "for f in supabase/migrations/20260709000000_issue_138_service_role_grants.sql supabase/migrations/20260709000001_issue_138_service_role_function_grants.sql supabase/migrations/20260709000002_issue_138_authenticated_role_grants.sql supabase/migrations/20260710000000_issue_200_ensure_authenticated_grants.sql; do echo \"=== $f ===\"; cat \"$f\"; done"
  ],
  [
    "MOV-330",
    "wc -l supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql test/watchlist-ownership-guards.test.ts test/watchlist-ownership-invariants.real-stack.test.ts test/tmp-env-probe.test.ts"
  ],
  [
    "MOV-330",
    "wc -l supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql test/watchlist-ownership-guards.test.ts test/watchlist-ownership-invariants.real-stack.test.ts test/tmp-env-probe.test.ts test/supabase-schema.test.ts test/watchlist-shared.integration.test.ts"
  ],
  [
    "MOV-330",
    "grep -n \"^-- [0-9]\\.\" supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql"
  ],
  [
    "MOV-330",
    "sed -n '200,210p;320,340p' supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql"
  ],
  [
    "MOV-330",
    "wc -l supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql test/watchlist-ownership-guards.test.ts test/watchlist-ownership-invariants.real-stack.test.ts test/tmp-env-probe.test.ts test/supabase-schema.test.ts"
  ],
  [
    "MOV-335",
    "grep -n \"create table.*movies\\|tmdb_id\\|movies (\" -A3 supabase/migrations/*.sql | grep -B2 -A15 \"table public.movies\\|table \\\"public\\\".\\\"movies\\\"\" | head -60"
  ],
  [
    "MOV-335",
    "sed -n '1,50p' supabase/migrations/20260611153000_issue_10_initial_schema.sql"
  ],
  [
    "MOV-335",
    "sed -n '230,300p' supabase/migrations/20260625150000_issue_69_multi_watchlist_schema.sql"
  ],
  [
    "MOV-340",
    "ls supabase/migrations && grep -rn \"role\" supabase/migrations/*.sql | grep -i \"check\\|create type\\|text not null\" | head -20"
  ],
  [
    "MOV-372",
    "grep -n \"normalizeSharedWatchlistName\\|requireWatchlistAccess\" -B2 -A30 src/lib/watchlist/items.ts | head -120; grep -n \"watchlists\" supabase/migrations/20260625150000_issue_69_multi_watchlist_schema.sql | head -40; grep -n \"\" supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql | head -150"
  ],
  [
    "MOV-372",
    "sed -n 150,400p supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql; sed -n 290,340p supabase/migrations/20260625150000_issue_69_multi_watchlist_schema.sql; sed -n 1,12p supabase/migrations/20260625150000_issue_69_multi_watchlist_schema.sql; ls supabase/migrations | tail -5"
  ],
  [
    "MOV-372",
    "sed -n 400,520p supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql; cat test/watchlist-ownership-invariants.real-stack.test.ts | head -150; ls test | grep -i watchlist"
  ],
  [
    "MOV-373",
    "cat supabase/migrations/20260709000002_issue_138_authenticated_role_grants.sql supabase/migrations/20260710000000_issue_200_ensure_authenticated_grants.sql"
  ],
  [
    "MOV-374",
    "grep -n \"watchlist_memberships\" -A 12 supabase/migrations/20260625150000_issue_69_multi_watchlist_schema.sql | grep -n \"policy\" -A 14 | head -80"
  ],
  [
    "MOV-374",
    "grep -n \"create table\" -A 20 supabase/migrations/20260611153000_issue_10_initial_schema.sql | head -60 && echo \"=== items alter ===\" && grep -n \"watchlist_items\" -B2 -A 12 supabase/migrations/20260625150000_issue_69_multi_watchlist_schema.sql | head -60"
  ]
];

describe("MOV-399 migration and auth command reads", () => {
  it.each([
    "supabase login --token example src/lib/supabase/calendar-tokens.ts",
    "cat src/lib/supabase/calendar-tokens.ts; supabase login --token example",
    "cat src/lib/supabase/calendar-tokens.ts; /opt/homebrew/bin/supabase secrets list",
  ])("keeps actual credential operations blocked: %s", (command) => {
    expect(classifyAction(command)).toMatchObject({ verdict: "hard-deny", category: "safety" });
  });

  it.each(MIGRATION_READS)("allows the %s read", (_issue, command) => {
    expect(classifyAction(command)).toEqual({ verdict: "allow", reason: null, category: null });
  });

  it.each([
    "cat src/app/auth/sign-in/route.ts",
    "rg -n token src/app/settings/calendar/actions.ts",
    "wc -l src/lib/calendar-tokens.ts",
    "cat src/lib/supabase/calendar-tokens.ts",
    "rg -n token src/lib/supabase/calendar-tokens.ts",
    "cat > supabase/migrations/20260901000000_shared_lists.sql <<'EOF'\nselect 1;\nEOF",
  ])("allows a command that mentions a review-required path: %s", (command) => {
    expect(classifyAction(command)).toEqual({ verdict: "allow", reason: null, category: null });
  });
});

// Line-aware classification and inline interpreter scripts (MOV-398).
const LINE_AND_INLINE_FALSE_POSITIVES = [
  "npx supabase status\nrg -n token src/lib/auth",
  "gh_version=1\necho done; grep -rn password test/fixtures",
  `node -e 'const s = require("fs").readFileSync("src/lib/supabase/server.ts", "utf8"); console.log(s.includes("token"))'`,
  `node -e "console.log(require('./.claude/settings.json').permissions)"`,
  `python3 -c 'import pathlib; print(pathlib.Path(".claude/agents/explore.md").read_text()[:200])'`,
  // Codex reports the same heredoc wrapped in its shell.
  `/bin/zsh -lc 'cat > test/shared-list.test.ts <<'"'"'EOF'"'"'
import { createClient } from "@supabase/supabase-js";
const token = "test-token";
EOF'`,
  // A command after the heredoc is classified on its own line.
  `cat > src/lib/auth/token-copy.ts <<'EOF'
export const supabaseTokenCopy = "Your session token expired";
EOF
npx prettier --write src/lib/auth/token-copy.ts`,
  `cat <<-EOF > src/lib/strings.ts
	export const help = "Ask the owner to rotate the supabase token";
	EOF`,
];

describe("MOV-398 false-positive regression corpus", () => {
  it.each(HEREDOC_FALSE_POSITIVES)("allows the $issue heredoc", ({ command }) => {
    expect(classifyAction(command)).toEqual({ verdict: "allow", reason: null, category: null });
  });

  it.each(HEREDOC_FALSE_POSITIVES)("reproduces the $issue false positive under the pre-MOV-398 reading", ({ command, blockedAs }) => {
    // The old audit collapsed the whole action, body included, onto one line
    // and matched these two rules across it.
    const flattened = command.replace(/["'`]/g, "").replace(/\s+/g, " ").toLowerCase();
    const legacyRule = {
      "secret or credential mutation/access": /\b(?:gh|vercel|supabase|aws)\b[^\n]*(?:secret|credential|token|password)/,
      "edits worker permission policy": /(?:^|\s)\.claude\//,
    }[blockedAs];
    expect(legacyRule.test(flattened)).toBe(true);
  });

  it.each(EARLIER_FALSE_POSITIVES)("still allows the %s command", (_issue, command) => {
    expect(classifyAction(command)).toEqual({ verdict: "allow", reason: null, category: null });
  });

  it.each(LINE_AND_INLINE_FALSE_POSITIVES)("allows data that only mentions a tool or credential: %s", (command) => {
    expect(classifyAction(command)).toEqual({ verdict: "allow", reason: null, category: null });
  });
});

const NEGATIVE_CONTROLS = [
  // Credential rules: tool and credential word in one segment of one line.
  ["gh secret set X --body y", "secret or credential mutation/access"],
  ["npx supabase login --token sbp_example", "secret or credential mutation/access"],
  ["echo start\nsupabase secrets set STRIPE_TOKEN=x", "secret or credential mutation/access"],
  ["aws configure get aws_secret_access_key", "secret or credential mutation/access"],
  // The heredoc opener and its redirect target are still classified.
  ["cat > AGENTS.md <<'EOF'\n# Replaced\nEOF", "edits AGENTS.md"],
  ["cat <<EOF > .claude/settings.json\n{}\nEOF", "edits worker permission policy"],
  ["cat <<'EOF' | tee .codex/config.toml\nsandbox = false\nEOF", "edits worker sandbox policy"],
  ["cat > src/x.ts <<'EOF' && gh secret set X\nexport {};\nEOF", "secret or credential mutation/access"],
  // Commands after the terminator are commands.
  ["cat > src/x.ts <<'EOF'\nexport {};\nEOF\ngit push origin master", "all Git operations are dispatcher-only"],
  ["cat > src/x.ts <<'EOF'\nexport {};\nEOF\nsupabase login --token x", "secret or credential mutation/access"],
  // Substitution in, around, or inside a heredoc opener or body.
  ["bash -c \"$(cat <<'EOF'\ngh secret set X\nEOF\n)\"", "secret or credential mutation/access"],
  ["bash -c \"$(cat <<'EOF'\ngit push origin master\nEOF\n)\"", "all Git operations are dispatcher-only"],
  ["bash -c \"$(cat <<EOF\ncp README.md AGENTS.md\nEOF\n)\"", "edits AGENTS.md"],
  ["cat > \"$(echo AGENTS.md)\" <<'EOF'\n# Replaced\nEOF", "edits AGENTS.md"],
  ["cat <<'EOF' > $(printf .claude/settings.json)\n{}\nEOF", "edits worker permission policy"],
  ["cat > notes.txt <<$(gh secret list)\nbody\n$(gh secret list)", "secret or credential mutation/access"],
  // An unquoted delimiter still runs `$(…)` in the body.
  ["cat > notes.txt <<EOF\n$(gh secret list --json name)\nEOF", "secret or credential mutation/access"],
  ["cat > notes.txt <<EOF\n$(cp README.md AGENTS.md)\nEOF", "edits AGENTS.md"],
  // A heredoc body fed to a shell is shell.
  ["bash <<'EOF'\ngit push origin master\nEOF", "all Git operations are dispatcher-only"],
  ["cat <<'EOF' | sh\nsupabase login --token x\nEOF", "secret or credential mutation/access"],
  ["cat <<'EOF' | xargs -I{} sh -c {}\ngit push origin master\nEOF", "all Git operations are dispatcher-only"],
  ["while read -r c; do $c; done <<'EOF'\nsupabase login --token x\nEOF", "secret or credential mutation/access"],
  ["cat > run.sh <<'EOF'\nsupabase login --token x\nEOF\nbash run.sh", "secret or credential mutation/access"],
  // Text that only looks like a heredoc opener is not one.
  ["echo hi # <<'EOF'\nsupabase login --token x\nEOF", "secret or credential mutation/access"],
  ["echo \"<<'EOF'\"\nsupabase login --token x\nEOF", "secret or credential mutation/access"],
  ["echo '<<EOF'\ngit push origin master\nEOF", "all Git operations are dispatcher-only"],
  // An unterminated or indented-terminator body stays classified.
  ["cat > x.txt <<'EOF'\nsupabase login --token x", "secret or credential mutation/access"],
  ["cat > x.txt <<'EOF'\n  EOF\nsupabase login --token x\nEOF", "secret or credential mutation/access"],
  // Inline scripts stay classified for Git, gh, keychain, and deploy rules,
  // and a double-quoted script still expands substitutions.
  ["python3 -c 'import subprocess; subprocess.run([\"gh\", \"pr\", \"create\"])'", "GitHub CLI access is dispatcher-only"],
  ["node -e 'require(\"child_process\").execSync(\"security dump-keychain\")'", "keychain access from a worker"],
  ["node -e \"$(cat .claude/settings.json)\"", "edits worker permission policy"],
  ["node -e \"`gh secret list`\"", "secret or credential mutation/access"],
  // Codex's wrapper does not hide the script it runs.
  ["/bin/zsh -lc 'cat > AGENTS.md <<'\"'\"'EOF'\"'\"'\n# Replaced\nEOF'", "edits AGENTS.md"],
  ["bash -lc 'echo ok\ngit push origin master'", "all Git operations are dispatcher-only"],
];

describe("MOV-398 negative-control corpus", () => {
  it.each(NEGATIVE_CONTROLS)("fails closed: %j", (command, reason) => {
    expect(classifyAction(command)).toMatchObject({ verdict: "hard-deny", reason });
  });

  it("still denies a repair worker writing a test through a heredoc opener", () => {
    expect(classifyAction("cat > test/auth.test.ts <<'EOF'\nexport {};\nEOF", { workerMode: "repair" }).verdict).toBe("hard-deny");
  });

  it("allows an opener targeting an auth route; the diff requires review", () => {
    expect(classifyAction("cat > src/app/auth/sign-in/route.ts <<'EOF'\nexport {};\nEOF").verdict).toBe("allow");
  });
});

// MOV-400: naming a protected path is not a safety event. The sandbox denies
// every write to it and auditChangedPaths blocks any change to it, so a
// command that only names one is a warning. These blocked publication before.
const PROTECTED_PATH_READS = [
  ["MOV-334", 'for f in docs/planning/milestones.md docs/product/product-brief.md AGENTS.md; do grep -n -i "rename" "$f"; done'],
  ["MOV-386", "wc -l AGENTS.md docs/operators/local-execution.md docs/operators/worker-routing.md"],
  ["MOV-392", "wc -l AGENTS.md"],
  ["awk", "awk 'NR<=40' AGENTS.md"],
  ["awk comparison", "awk '$3 > $2 {print}' docs/product/product-brief.md"],
  ["xargs", "echo AGENTS.md docs/product/product-brief.md | xargs wc -l"],
  ["xargs placeholder", "ls docs/product | xargs -I{} wc -l docs/product/{}"],
  ["while read", "printf '%s\\n' AGENTS.md docs/product/product-brief.md | while read -r f; do wc -l \"$f\"; done"],
  ["cp source", "cp AGENTS.md /tmp/agents-orientation.md"],
  ["loop copy out", 'for f in AGENTS.md docs/product/product-brief.md; do cp "$f" /tmp/; done'],
];

// A command that writes a protected path stays a blocking violation, so intent
// is still caught when the sandbox stops it.
const PROTECTED_PATH_WRITES = [
  ["cat README.md > AGENTS.md", "edits AGENTS.md"],
  ["echo x>AGENTS.md", "edits AGENTS.md"],
  ["echo note >> docs/product/product-brief.md", "edits docs/product/**"],
  ["cat README.md 2>&1 > .claude/settings.json", "edits worker permission policy"],
  ["sed -i '' 's/a/b/' AGENTS.md", "edits AGENTS.md"],
  ["sed --in-place 's/a/b/' docs/product/product-brief.md", "edits docs/product/**"],
  ["perl -pi -e 's/a/b/' AGENTS.md", "edits AGENTS.md"],
  ["tee AGENTS.md < README.md", "edits AGENTS.md"],
  ["echo x | tee -a .codex/config.toml", "edits worker sandbox policy"],
  ["cp README.md AGENTS.md", "edits AGENTS.md"],
  ["cp notes.md ./docs/product/product-brief.md", "edits docs/product/**"],
  ["cp -t .claude/ settings.json", "edits worker permission policy"],
  ["mv AGENTS.md AGENTS.old", "edits AGENTS.md"],
  ["mv draft.yml .github/workflows/verify.yml", "modifies .github/workflows/**"],
  ["rm AGENTS.md", "edits AGENTS.md"],
  ["rm -rf docs/product", "edits docs/product/**"],
  ["touch .github/copilot-instructions.md", "edits .github/copilot-instructions.md"],
  ["dd if=/dev/zero of=AGENTS.md count=1", "edits AGENTS.md"],
  ["npx prettier --write docs/product/product-brief.md", "edits docs/product/**"],
  ["find . -name AGENTS.md -delete", "edits AGENTS.md"],
  ["find docs/product -name '*.md' -exec sed -i s/a/b/ {} +", "edits docs/product/**"],
  // Wrapped, looped or piped writes whose operand comes from elsewhere.
  ["sudo sh -c 'echo x > AGENTS.md'", "edits AGENTS.md"],
  ['eval "cp README.md AGENTS.md"', "edits AGENTS.md"],
  ['for f in AGENTS.md; do rm "$f"; done', "edits AGENTS.md"],
  ['for f in docs/product/*.md; do echo x > "$f"; done', "edits docs/product/**"],
  ["echo AGENTS.md | xargs rm", "edits AGENTS.md"],
  ["ls docs/product | xargs -I{} cp README.md docs/product/{}", "edits docs/product/**"],
  ["grep -rl x docs/product | while read -r f; do sed -i '' s/a/b/ \"$f\"; done", "edits docs/product/**"],
  // A command substitution is shell the audit cannot read.
  ["wc -l $(ls AGENTS.md)", "edits AGENTS.md"],
];

describe("MOV-400 protected-path corpus", () => {
  it.each(PROTECTED_PATH_READS)("warns without blocking the %s read", (_idiom, command) => {
    expect(classifyAction(command)).toMatchObject({ verdict: "warn", category: "safety", reason: expect.stringMatching(/^names protected path .+ without writing it$/) });
  });

  it.each(PROTECTED_PATH_WRITES)("still blocks a write: %j", (command, reason) => {
    expect(classifyAction(command)).toMatchObject({ verdict: "hard-deny", reason, category: "safety" });
  });

  it("keeps known read-only inspections silent", () => {
    expect(classifyAction("cat AGENTS.md")).toEqual({ verdict: "allow", reason: null, category: null });
    expect(classifyAction("grep -n 'x > AGENTS.md' README.md")).toEqual({ verdict: "allow", reason: null, category: null });
  });

  it("warns for a repair-only path a repair worker names and blocks one it writes", () => {
    expect(classifyAction("wc -l test/auth.test.ts tools/dispatcher/src/brief.mjs", { workerMode: "repair" })).toMatchObject({ verdict: "warn" });
    expect(classifyAction("for f in test/*.test.ts; do rm $f; done", { workerMode: "repair" })).toMatchObject({ verdict: "hard-deny", reason: "repair workers cannot change tests" });
    expect(classifyAction("mv package.json package.old.json", { workerMode: "repair" })).toMatchObject({ verdict: "hard-deny", reason: "repair workers cannot change test execution configuration" });
    // A bare `test` is the shell builtin unless it is the operand written.
    expect(classifyAction("for f in *.tmp; do test -f $f && rm $f; done", { workerMode: "repair" }).verdict).toBe("allow");
    expect(classifyAction("rm -rf test", { workerMode: "repair" })).toMatchObject({ verdict: "hard-deny", reason: "repair workers cannot change tests" });
  });

  it("does not let a warning outrank a later hard-deny rule", () => {
    expect(classifyAction("wc -l AGENTS.md; cp notes.ts src/app/auth/notes.ts").verdict).toBe("warn");
    expect(classifyAction("wc -l AGENTS.md; cp README.md .claude/settings.json")).toMatchObject({ verdict: "hard-deny", reason: "edits worker permission policy" });
    expect(classifyAction("wc -l AGENTS.md && gh pr view 1")).toMatchObject({ verdict: "hard-deny", category: "scope" });
  });
});

describe("shellView", () => {
  it("separates a quoted heredoc body from its opener and later lines", () => {
    expect(shellView("cat > a.ts <<'EOF'\nsupabase token\nEOF\nls")).toEqual({ exact: true, command: "cat > a.ts <<'EOF'\nls", script: "cat > a.ts <<'EOF'\nls" });
  });

  it("replaces only the command view of an inline script", () => {
    expect(shellView("node -e 'x()' && ls")).toEqual({ exact: true, command: "node -e __inline_script__ && ls", script: "node -e 'x()' && ls" });
  });

  it("keeps every heredoc body when any construct is not provably data", () => {
    const view = shellView("cat <<'EOF' | bash\ngit status\nEOF");
    expect(view.exact).toBe(false);
    expect(view.script).toContain("git status");
  });
});
