// Worker + model routing.
//
// Implements the rubric documented in docs/operators/worker-routing.md.
// Pure functions only — no I/O — so this is fully unit-testable without a
// live Linear connection or a real worktree.

import { turnBudgetForTier } from "./turn-budget.mjs";

export const WORKERS = ["claude", "codex"];
export const MODEL_TIERS = ["cheap", "default", "strong"];

// MOV-237: These denies deliberately live with workerInvocation(), rather
// than in tracked .claude/settings.json. A project settings file is applied to
// every Claude session rooted in the repository, including a human's ordinary
// interactive worktree. The dispatcher alone passes this settings payload, so
// the early Claude-level defense in depth remains worker-scoped. The outer
// worker-guard.mjs Seatbelt profile remains the authoritative enforcement
// boundary and independently enforces these restrictions.
export const CLAUDE_WORKER_PERMISSION_DENIES = [
  "Bash(git*)",
  "Bash(gh api*)",
  "Bash(gh pr create*)",
  "Bash(gh pr edit*)",
  "Bash(gh pr merge*)",
  "Bash(gh pr close*)",
  "Bash(gh issue*)",
  "Bash(gh secret*)",
  "Bash(gh ruleset*)",
  "Bash(gh release*)",
  "Bash(gh repo delete*)",
  "Bash(curl*)",
  "Bash(wget*)",
  "Bash(ssh*)",
  "Bash(scp*)",
  "Bash(sftp*)",
  "Bash(security*)",
  "Bash(npm publish*)",
  "Bash(vercel*)",
  "Bash(supabase *reset*)",
  "Bash(supabase *drop*)",
  "Bash(*SUPABASE_DB_URL_PROD*)",
  "Read(~/.config/gh/**)",
  "Read(~/.config/moviecal/**)",
  "Read(~/.ssh/**)",
  "Read(~/.git-credentials)",
  "Read(~/.netrc)",
  "Read(~/.npmrc)",
  "Read(.env)",
  "Read(.env.local)",
  "Edit(AGENTS.md)",
  "Edit(.github/copilot-instructions.md)",
  "Edit(docs/product/**)",
  "Edit(.github/workflows/**)",
  "Edit(.claude/**)",
  "Edit(.codex/**)",
];

export const CLAUDE_WORKER_SETTINGS = {
  permissions: { deny: CLAUDE_WORKER_PERMISSION_DENIES },
  // Claude's own inner sandbox cannot nest within worker-guard.mjs's
  // restrictive Seatbelt profile. The outer profile remains fail-closed.
  sandbox: { enabled: false },
};

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

/** Preserve a worker:any attempt's provider binding; fresh claims retain Claude. */
export function resolveDispatchWorker(issue, { boundWorker = null } = {}) {
  const routing = resolveRouting(issue);
  const isAny = parseRoutingLabels(issue.labels || []).worker === "any";
  const bound = routing.ok && isAny && (boundWorker === "claude" || boundWorker === "codex");
  return { ...routing, worker: bound ? boundWorker : routing.worker, isAny, available: true, bound };
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
// the base project allow list, the worker-only deny list below, or the
// built-in read-only command set, instead of
// prompting -- so an unmatched call fails cleanly rather than hanging. (A
// newer, more precise combination -- `acceptEdits` plus `--permission-prompts
// none` -- requires Claude Code v2.1.259+; the installed version rejects
// `--permission-prompts` as an unknown option, so this uses the
// version-compatible single flag instead.) Permission rules (including the
// deny list in CLAUDE_WORKER_SETTINGS) are enforced by Claude Code's own
// harness code, not by the model choosing to comply -- see
// docs/operators/local-execution.md §Security model for what that boundary
// does and does not cover.
/**
 * @param {"claude"|"codex"} worker
 * @param {"cheap"|"default"|"strong"} model
 * @param {{steering?: boolean}} [opts] - MOV-214/215: `steering: true` adds
 *   `--input-format stream-json` so the dispatcher can write further turns
 *   onto the worker's still-open stdin (see worker-spawn.mjs's `steering`
 *   option). Claude only -- Codex has no equivalent interactive protocol, so
 *   `opts.steering` is silently ignored for it; the returned invocation is
 *   identical either way. Every existing safety flag
 *   (`--permission-mode dontAsk`, `--safe-mode`, `--strict-mcp-config`, the
 *   sandbox-disabling `--settings`) is unaffected -- steering only changes
 *   how additional conversational turns reach the process, never what the
 *   process is allowed to do.
 */
export function workerInvocation(worker, model, { steering = false } = {}) {
  turnBudgetForTier(model); // validate env overrides on every routing surface, including dry-run
  if (worker === "claude") {
    const modelId = modelIdForTier("claude", model);
    const effort = claudeEffortForTier(model, modelId);
    return {
      command: "claude",
      reasoningEffort: effort, // MOV-363 usage record can persist the effective flag value.
      args: [
        "-p",
        "--model",
        modelId,
        ...(effort ? ["--effort", effort] : []),
        "--permission-mode",
        "dontAsk",
        "--setting-sources",
        "project",
        "--safe-mode",
        "--strict-mcp-config",
        "--no-chrome",
        "--disable-slash-commands",
        "--output-format",
        "stream-json",
        ...(steering ? ["--input-format", "stream-json"] : []),
        "--verbose",
        "--no-session-persistence",
        // MOV-184: Claude Code's own internal per-command Bash-tool sandbox
        // (a second, independent Seatbelt sandbox_apply call) collides with
        // worker-guard.mjs's outer sandbox-exec profile -- once a process is
        // confined by a profile with any (deny ...) rule (not just "nested
        // sandboxing" generally; a pure allow-default profile can still
        // nest), it can never call sandbox_apply on itself again. Verified
        // empirically: this fails on every dispatched Claude worker that
        // touches the Bash tool, deterministically, not intermittently. The
        // outer profile already provides the complete security boundary
        // (docs/operators/local-execution.md §Security model), so Claude's
        // own inner sandbox is redundant, not protective -- disable it here
        // rather than leave two colliding layers where only one is needed.
        "--settings",
        JSON.stringify(CLAUDE_WORKER_SETTINGS),
      ],
    };
  }
  if (worker === "codex") {
    const args = [
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--strict-config",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "-c",
      `model_reasoning_effort=${codexReasoningEffortForTier(model)}`,
    ];
    const codexModel = codexModelIdForTier(model);
    args.push("--model", codexModel);
    return { command: "codex", args };
  }
  throw new Error(`unknown worker: ${worker}`);
}

/** Haiku 4.5 rejects the effort parameter, including dated model IDs. */
export function claudeModelDoesNotSupportEffort(modelId) {
  return /^claude-haiku-4-5(?:$|-)/.test(modelId);
}

/** Return the effective CLI effort, or null when the flag must be omitted. */
export function claudeEffortForTier(tier, modelId = modelIdForTier("claude", tier)) {
  const table = {
    cheap: process.env.MOVIECAL_CLAUDE_EFFORT_CHEAP ?? "none",
    default: process.env.MOVIECAL_CLAUDE_EFFORT_DEFAULT ?? "medium",
    strong: process.env.MOVIECAL_CLAUDE_EFFORT_STRONG ?? "high",
  };
  if (!(tier in table)) throw new Error(`unknown model tier: ${tier}`);
  const effort = table[tier];
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error(`invalid Claude effort ${JSON.stringify(effort)} for ${tier} tier; expected none, low, medium, high, xhigh, or max`);
  }
  return effort === "none" || claudeModelDoesNotSupportEffort(modelId) ? null : effort;
}

/**
 * Resolve a model tier ('cheap'|'default'|'strong') to a concrete model ID
 * for the given worker. Deliberately not hard-coded to a single catalog
 * entry per docs/operators/worker-routing.md — this is the one place that
 * needs updating when the model catalog changes.
 */
export function modelIdForTier(worker, tier) {
  if (worker !== "claude") return null; // Codex uses codexModelIdForTier().
  const table = {
    cheap: process.env.MOVIECAL_MODEL_CHEAP || "claude-haiku-4-5",
    default: process.env.MOVIECAL_MODEL_DEFAULT || "claude-sonnet-5",
    strong: process.env.MOVIECAL_MODEL_STRONG || "claude-opus-5-5",
  };
  const id = table[tier];
  if (!id) throw new Error(`unknown model tier: ${tier}`);
  return id;
}

/**
 * Resolve a model tier to a Codex `model_reasoning_effort` value. Mirrors
 * modelIdForTier's env-override pattern, defaulting to low/medium/high.
 */
export function codexReasoningEffortForTier(tier) {
  const table = {
    cheap: process.env.MOVIECAL_CODEX_EFFORT_CHEAP || "low",
    default: process.env.MOVIECAL_CODEX_EFFORT_DEFAULT || "medium",
    strong: process.env.MOVIECAL_CODEX_EFFORT_STRONG || "high",
  };
  const effort = table[tier];
  if (!effort) throw new Error(`unknown model tier: ${tier}`);
  return effort;
}

/**
 * Resolve a model tier to an explicit Codex `--model` ID. Per-tier environment
 * overrides take precedence over these defaults; --ignore-user-config means
 * worker invocations never rely on a personal config.toml model.
 */
export function codexModelIdForTier(tier) {
  const table = {
    cheap: process.env.MOVIECAL_CODEX_MODEL_CHEAP || "gpt-6-luna",
    default: process.env.MOVIECAL_CODEX_MODEL_DEFAULT || "gpt-6-sol",
    strong: process.env.MOVIECAL_CODEX_MODEL_STRONG || "gpt-6-sol",
  };
  if (!(tier in table)) throw new Error(`unknown model tier: ${tier}`);
  return table[tier];
}
