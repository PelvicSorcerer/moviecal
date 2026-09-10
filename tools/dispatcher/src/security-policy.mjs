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

const COMMAND_RULES = [
  {
    re: /(?:^|[;&|]\s*|\b(?:command|exec|xcrun|sh +-c|bash +-c|zsh +-c) +|\/)(?:usr\/bin\/|usr\/local\/bin\/|opt\/homebrew\/bin\/)?git\b/,
    reason: "all Git operations are dispatcher-only",
  },
  { re: /\bgh\b/, reason: "GitHub CLI access is dispatcher-only" },
  { re: /\b(?:curl|wget)\b[^\n]*(?:api\.github\.com|github\.com\/api|uploads\.github\.com)/, reason: "alternate GitHub API path" },
  { re: /\b(?:ssh|scp|sftp)\b/, reason: "direct SSH transport is not available to workers" },
  { re: /\bsecurity +(?:find|dump|export|unlock|set|add|delete)-/, reason: "keychain access from a worker" },
  { re: /\b(?:gh|vercel|supabase|npm|aws)\b[^\n]*(?:secret|credential|token|password)/, reason: "secret or credential mutation/access" },
  { re: /\b(?:printenv|env|set)\b[^\n]*(?:key|token|secret|password)/, reason: "prints credential-shaped environment data" },
  { re: /\b(?:echo|printf)\b[^\n]*(?:key|token|secret|password)/, reason: "prints credential-shaped data" },
  { re: /supabase_db_url_prod/, reason: "references the production database URL" },
  { re: /\bsupabase\b[^\n]*(?:db +(?:reset|push)|migration +up|link|functions +deploy|projects? +(?:create|delete))\b/, reason: "mutates a Supabase resource" },
  { re: /\bvercel\b[^\n]*(?:--prod\b| +deploy\b| +promote\b| +alias\b| +domains?\b| +env\b)/, reason: "mutates a Vercel or production resource" },
  { re: /\bgh +release\b/, reason: "mutates a GitHub release" },
  { re: /\bnpm +publish\b/, reason: "publishes a package" },
];

const PATH_RULES = [
  { re: /(?:^|\s)\.github\/workflows\//, reason: "modifies .github/workflows/**" },
  { re: /(?:^|\s)agents\.md\b/, reason: "edits AGENTS.md" },
  { re: /\.github\/copilot-instructions\.md\b/, reason: "edits .github/copilot-instructions.md" },
  { re: /(?:^|\s)docs\/product\//, reason: "edits docs/product/**" },
  { re: /(?:^|\s)\.claude\//, reason: "edits worker permission policy" },
  { re: /(?:^|\s)\.codex\//, reason: "edits worker sandbox policy" },
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
  for (const { re, reason } of [...COMMAND_RULES, ...PATH_RULES]) {
    if (re.test(normalized)) return { verdict: "hard-deny", reason };
  }
  if (workerMode === "repair") {
    for (const { re, reason } of REPAIR_ONLY_RULES) {
      if (re.test(normalized)) return { verdict: "hard-deny", reason };
    }
  }
  for (const { re, reason } of HUMAN_DECISION_PATTERNS) {
    if (re.test(normalized)) return { verdict: "needs-human", reason };
  }
  return { verdict: "allow", reason: null };
}
