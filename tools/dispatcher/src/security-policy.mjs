// Hard-deny and human-decision command classification.
//
// Implements the security model documented in
// docs/operators/local-execution.md §Security model. This is a
// defense-in-depth layer inside the dispatcher itself, on top of (not
// instead of) the GitHub branch ruleset, which is the actual enforcement
// boundary for merge-time safety.

const HARD_DENY_PATTERNS = [
  { re: /\bgit\s+push\b.*(--force|-f\b|--force-with-lease)/, reason: "force-push" },
  { re: /\bgit\s+push\b[^|;&]*\bmaster\b/, reason: "push to master" },
  { re: /\bgit\s+branch\s+-D\b/, reason: "force branch deletion" },
  { re: /\.github\/workflows\//, reason: "modifies .github/workflows/**" },
  { re: /\bgh\s+secret\s+set\b/, reason: "gh secret set" },
  { re: /\becho\b.*(KEY|TOKEN|SECRET|PASSWORD)\b/i, reason: "echoes a credential-shaped env var" },
  { re: /SUPABASE_DB_URL_PROD/, reason: "references SUPABASE_DB_URL_PROD" },
  { re: /\bsupabase\s+db\s+reset\b/, reason: "supabase db reset" },
  { re: /\bvercel\b.*--prod\b/, reason: "vercel --prod" },
  { re: /\bgh\s+release\s+create\b/, reason: "gh release create" },
  { re: /\bnpm\s+publish\b/, reason: "npm publish" },
  { re: /\bAGENTS\.md\b/, reason: "edits AGENTS.md" },
  { re: /\.github\/copilot-instructions\.md\b/, reason: "edits .github/copilot-instructions.md" },
  { re: /\bdocs\/product\//, reason: "edits docs/product/**" },
];

const HUMAN_DECISION_PATTERNS = [
  { re: /\bsupabase\/migrations\//, reason: "database migration touching existing tables — needs human review" },
  { re: /\bsrc\/app\/(auth|settings\/calendar)\//, reason: "auth or calendar-token logic — needs human review" },
];

/**
 * Classify a shell command (or a file path being modified) the worker is
 * about to run. Returns { verdict: 'allow'|'hard-deny'|'needs-human', reason }.
 */
export function classifyAction(text) {
  for (const { re, reason } of HARD_DENY_PATTERNS) {
    if (re.test(text)) return { verdict: "hard-deny", reason };
  }
  for (const { re, reason } of HUMAN_DECISION_PATTERNS) {
    if (re.test(text)) return { verdict: "needs-human", reason };
  }
  return { verdict: "allow", reason: null };
}
