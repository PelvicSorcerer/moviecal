// Semantic hard-deny classification used by the shared worker guard.
//
// This is an audit layer, not the sole enforcement boundary: worker-guard.mjs
// also applies an inherited macOS sandbox, removes privileged credentials,
// validates the resulting diff, and keeps all remote publication in the
// trusted dispatcher process.

function canonicalize(text) {
  return String(text || "")
    .replace(/\\\s/g, " ")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
  { re: /\b(?:gh|vercel|supabase|npm|aws)\b[^\n]*(?:secret|credential|token|password)/, reason: "secret or credential mutation/access", category: "safety" },
  { re: /\b(?:printenv|env|set)\b[^\n]*(?:key|token|secret|password)/, reason: "prints credential-shaped environment data", category: "safety" },
  { re: /\b(?:echo|printf)\b[^\n]*(?:key|token|secret|password)/, reason: "prints credential-shaped data", category: "safety" },
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
  for (const { re, reason, category } of [...COMMAND_RULES, ...PATH_RULES]) {
    if (re.test(normalized)) return { verdict: "hard-deny", reason, category };
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
