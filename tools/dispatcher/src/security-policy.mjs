// Semantic hard-deny classification used by the shared worker guard.
//
// This is an audit layer, not the sole enforcement boundary: worker-guard.mjs
// also applies an inherited macOS sandbox, removes privileged credentials,
// validates the resulting diff, and keeps all remote publication in the
// trusted dispatcher process.

function canonicalize(text) {
  return String(text || "")
    // An escaped shell operator is literal data, not a command separator. Keep
    // it distinct while normalizing so a regex such as `foo\\|git` cannot be
    // mistaken for a pipeline that invokes Git.
    .replace(/\\([;|&])/g, "__literal_operator_$1__")
    .replace(/\\\s/g, " ")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shellSegments(normalized) {
  return normalized.split(/\s*(?:&&|\|\||[;|&])\s*/);
}

function isCredentialOperation(segment) {
  if (!/\bnpm\b/.test(segment)) return false;

  // `npm run <script>` is local script execution. Its script name and
  // pass-through test paths must not be interpreted as npm credential access.
  // Other npm subcommands retain the existing conservative detection.
  const withoutRunInvocation = segment.replace(/\bnpm\s+run\s+\S+(?:\s+.*)?$/, "npm run");
  return /\bnpm\b[^\n]*(?:secret|credential|token|password)/.test(withoutRunInvocation);
}

// Protected repository paths are protected from modification, not from the
// orientation reads every worker must make before acting. Keep this list small
// and intentionally boring: an unknown command mentioning a protected path is
// a safety denial, while these commands can only inspect it. `sed -i` is the
// important exception because it mutates in place.
const READ_ONLY_PATH_COMMANDS = /^(?:cat|head|tail|grep|rg|ls|stat|sed|find)\b/;

function writesProtectedPath(segment, pathRule) {
  // A protected path on the right of a shell redirect is a write even when the
  // command on the left is ordinarily read-only (for example,
  // `cat README.md > AGENTS.md`).
  if (new RegExp(`(?:^|\\s)\\d?(?:>>|>)\\s*${pathRule.source}`).test(segment)) return true;
  // `sed` is read-only unless explicitly asked to edit in place.
  if (/^(?:sed)\b[^\n]*(?:\s-[a-z]*i[a-z]*(?:\s|$)|\s--in-place(?:=|\s|$))/.test(segment)) return true;
  // `find` only ever mutates through one of its action primaries: -exec/-ok
  // (and their -dir variants) run an arbitrary command, -delete removes
  // matches, and -fprint*/-fls write results to a file. A protected path can
  // otherwise appear anywhere in a `find` invocation — as a match target
  // (`-name`) or a comparison argument (`-newer`) — without ever being
  // written to.
  return /^find\b[^\n]*(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)\b/.test(segment);
}

function isReadOnlyProtectedPathInspection(normalized, pathRule) {
  const references = shellSegments(normalized).filter((segment) => pathRule.test(segment));
  return references.length > 0 && references.every(
    (segment) => READ_ONLY_PATH_COMMANDS.test(segment) && !writesProtectedPath(segment, pathRule),
  );
}

// A scope rule protects the dispatcher's ownership of an operational tool.
// A safety rule protects secrets, irreversible actions, or the policy itself.
// The distinction is consumed by worker-guard.mjs: a command the native
// harness demonstrably denied is a warning only for scope rules, while every
// safety attempt remains fail-closed.
export const COMMAND_RULES = [
  {
    re: /(?:^|[;&|]\s*|\b(?:command|exec|xcrun|sh +-c|bash +-c|zsh +-c) +|\/)(?:usr\/bin\/|usr\/local\/bin\/|opt\/homebrew\/bin\/)?git\b/,
    reason: "all Git operations are dispatcher-only",
    category: "scope",
  },
  { re: /\bsecurity +(?:find|dump|export|unlock|set|add|delete)-/, reason: "keychain access from a worker", category: "safety" },
  { re: /\b(?:gh|vercel|supabase|aws)\b[^\n]*(?:secret|credential|token|password)/, reason: "secret or credential mutation/access", category: "safety" },
  {
    test: (normalized) => shellSegments(normalized).some(isCredentialOperation),
    reason: "secret or credential mutation/access",
    category: "safety",
  },
  { re: /\b(?:printenv|env|set)\b[^\n]*(?:key|token|secret|password)/, reason: "prints credential-shaped environment data", category: "safety" },
  { re: /\b(?:echo|printf)\b[^;|&\n]*(?:key|token|secret|password)/, reason: "prints credential-shaped data", category: "safety" },
  { re: /supabase_db_url_prod/, reason: "references the production database URL", category: "safety" },
  { re: /\bsupabase\b[^\n]*(?:db +(?:reset|push)|migration +up|link|functions +deploy|projects? +(?:create|delete))\b/, reason: "mutates a Supabase resource", category: "safety" },
  { re: /\bvercel\b[^\n]*(?:--prod\b| +deploy\b| +promote\b| +alias\b| +domains?\b| +env\b)/, reason: "mutates a Vercel or production resource", category: "safety" },
  { re: /\bgh +release\b/, reason: "mutates a GitHub release", category: "safety" },
  { re: /\bnpm +publish\b/, reason: "publishes a package", category: "safety" },
  // Keep generic operational ownership rules after the safety-specific
  // variants above: `gh secret set` and `gh release` must not be downgraded
  // to a scope finding merely because they also contain the `gh` binary.
  { re: /\bgh\b/, reason: "GitHub CLI access is dispatcher-only", category: "scope" },
  { re: /\b(?:curl|wget)\b[^\n]*(?:api\.github\.com|github\.com\/api|uploads\.github\.com)/, reason: "alternate GitHub API path", category: "scope" },
  { re: /\b(?:ssh|scp|sftp)\b/, reason: "direct SSH transport is not available to workers", category: "scope" },
];

export const PATH_RULES = [
  { re: /(?:^|\s)\.github\/workflows\//, reason: "modifies .github/workflows/**", category: "safety" },
  { re: /(?:^|\s)agents\.md\b/, reason: "edits AGENTS.md", category: "safety" },
  { re: /\.github\/copilot-instructions\.md\b/, reason: "edits .github/copilot-instructions.md", category: "safety" },
  { re: /(?:^|\s)docs\/product\//, reason: "edits docs/product/**", category: "safety" },
  { re: /(?:^|\s)\.claude\//, reason: "edits worker permission policy", category: "safety" },
  { re: /(?:^|\s)\.codex\//, reason: "edits worker sandbox policy", category: "safety" },
];

const REPAIR_ONLY_RULES = [
  { re: /(?:^|\s)(?:test|tests|e2e)\//, reason: "repair workers cannot change tests" },
  { re: /(?:^|\s)docs\/(?:governance|operators|planning)\//, reason: "repair workers cannot change governance" },
  { re: /(?:^|\s)tools\/dispatcher\//, reason: "repair workers cannot change their dispatcher guard" },
  { re: /(?:^|\s)(?:package(?:-lock)?\.json|(?:playwright|vitest(?:\.[\w-]+)?)\.config\.[cm]?[jt]s)\b/, reason: "repair workers cannot change test execution configuration" },
];

const HUMAN_DECISION_PATTERNS = [
  { re: /(?:^|\s)supabase\/migrations\//, reason: "database migration touching existing tables — needs human review" },
  { re: /(?:^|\s)src\/app\/(?:auth|settings\/calendar)\//, reason: "auth or calendar-token logic — needs human review" },
];

/** Classify a structured tool command or file path. */
export function classifyAction(text, { workerMode = "implementation" } = {}) {
  const normalized = canonicalize(text);
  for (const { re, test, reason, category } of COMMAND_RULES) {
    if ((test ? test(normalized) : re.test(normalized))) return { verdict: "hard-deny", reason, category };
  }
  for (const { re, reason, category } of PATH_RULES) {
    if (re.test(normalized) && !isReadOnlyProtectedPathInspection(normalized, re)) {
      return { verdict: "hard-deny", reason, category };
    }
  }
  if (workerMode === "repair") {
    for (const { re, reason } of REPAIR_ONLY_RULES) {
      if (re.test(normalized)) return { verdict: "hard-deny", reason, category: "safety" };
    }
  }
  for (const { re, reason } of HUMAN_DECISION_PATTERNS) {
    if (re.test(normalized)) return { verdict: "needs-human", reason, category: "safety" };
  }
  return { verdict: "allow", reason: null, category: null };
}
