// Worker + model routing.
//
// Implements the rubric documented in docs/operators/worker-routing.md.
// Pure functions only — no I/O — so this is fully unit-testable without a
// live Linear connection or a real worktree.

export const WORKERS = ["claude", "codex"];
export const MODEL_TIERS = ["cheap", "default", "strong"];

const WORKER_LABEL_RE = /^worker:(claude|codex|any)$/;
const MODEL_LABEL_RE = /^model:(cheap|default|strong)$/;

/**
 * Parse worker/model overrides out of a Linear issue's label list.
 * Returns { worker: 'claude'|'codex'|'any'|null, model: 'cheap'|'default'|'strong'|null }.
 * A human-applied label always wins over the default rubric below.
 */
export function parseRoutingLabels(labels = []) {
  let worker = null;
  let model = null;
  for (const label of labels) {
    const workerMatch = WORKER_LABEL_RE.exec(label);
    if (workerMatch) worker = workerMatch[1];
    const modelMatch = MODEL_LABEL_RE.exec(label);
    if (modelMatch) model = modelMatch[1];
  }
  return { worker, model };
}

/**
 * Default routing decision from labels alone (task-shape signals — area,
 * risk — are advisory context a human supplies via labels/description; this
 * function does not attempt to infer task shape from issue text).
 *
 * Default worker is 'claude' (either is only used when explicitly labeled
 * worker:any or worker:codex). Default model tier is 'default'; 'cheap' and
 * 'strong' both require the human to have applied the model:cheap or
 * model:strong label explicitly (strong further requires an upgrade
 * condition — see resolveRouting's return value).
 */
export function resolveRouting(issue) {
  const labels = issue.labels || [];
  const { worker: workerOverride, model: modelOverride } = parseRoutingLabels(labels);

  const worker = workerOverride && workerOverride !== "any" ? workerOverride : "claude";
  const model = modelOverride || "default";

  const upgradeConditions = labels
    .filter((l) => l.startsWith("upgrade:"))
    .map((l) => l.slice("upgrade:".length));

  if (model === "strong" && upgradeConditions.length === 0) {
    return {
      worker,
      model,
      ok: false,
      reason:
        "model:strong requires an upgrade-condition label (upgrade:multi-system | upgrade:ambiguous-spec | upgrade:security-critical | upgrade:prior-failure | upgrade:architecture)",
    };
  }

  return { worker, model, ok: true, reason: null, upgradeConditions };
}

// Both workers read their brief from stdin rather than a file path argument
// (worker-spawn.mjs pipes it), since a stdin brief works identically whether
// the worker binary reads from a real TTY-less pipe or a piped-in file.
//
// Claude's `-p` (print/non-interactive) mode starts in Manual permission mode
// on every plan -- with no explicit mode set, a tool call that would need
// approval genuinely blocks waiting for an answer that can never come in a
// headless subprocess with no TTY (verified directly against the CLI version
// installed on this Mac, 2.1.208). `--permission-mode dontAsk` is the fix:
// it auto-denies anything not already covered by permissions.allow in
// .claude/settings.json or the built-in read-only command set, instead of
// prompting -- so an unmatched call fails cleanly rather than hanging. (A
// newer, more precise combination -- `acceptEdits` plus `--permission-prompts
// none` -- requires Claude Code v2.1.259+; the installed version rejects
// `--permission-prompts` as an unknown option, so this uses the
// version-compatible single flag instead.) Permission rules (including the
// deny list in .claude/settings.json) are enforced by Claude Code's own
// harness code, not by the model choosing to comply -- see
// docs/operators/local-execution.md §Security model for what that boundary
// does and does not cover.
export function workerInvocation(worker, model) {
  if (worker === "claude") {
    return {
      command: "claude",
      args: ["-p", "--model", modelIdForTier("claude", model), "--permission-mode", "dontAsk"],
    };
  }
  if (worker === "codex") {
    return {
      command: "codex",
      args: ["exec", "--sandbox", "workspace-write"],
    };
  }
  throw new Error(`unknown worker: ${worker}`);
}

/**
 * Resolve a model tier ('cheap'|'default'|'strong') to a concrete model ID
 * for the given worker. Deliberately not hard-coded to a single catalog
 * entry per docs/operators/worker-routing.md — this is the one place that
 * needs updating when the model catalog changes.
 */
export function modelIdForTier(worker, tier) {
  if (worker !== "claude") return null; // codex resolves its own default
  const table = {
    cheap: process.env.MOVIECAL_MODEL_CHEAP || "claude-haiku-4-5",
    default: process.env.MOVIECAL_MODEL_DEFAULT || "claude-sonnet-5",
    strong: process.env.MOVIECAL_MODEL_STRONG || "claude-opus-5",
  };
  const id = table[tier];
  if (!id) throw new Error(`unknown model tier: ${tier}`);
  return id;
}
