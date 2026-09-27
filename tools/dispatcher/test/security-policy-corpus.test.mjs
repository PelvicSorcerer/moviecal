import { describe, it, expect } from "vitest";
import { classifyAction, shellView } from "../src/security-policy.mjs";

// MOV-398: commands that blocked publication in error, and the controls that
// must stay fail-closed. Add every future false positive to FALSE_POSITIVES
// with the reason it was blocked under, and a matching control when the fix
// narrows a rule.

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

  it("keeps the needs-human classification for an opener that targets an auth route", () => {
    expect(classifyAction("cat > src/app/auth/sign-in/route.ts <<'EOF'\nexport {};\nEOF").verdict).toBe("needs-human");
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
