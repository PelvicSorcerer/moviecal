# Worker and model routing policy

Read `AGENTS.md` and `docs/operators/local-execution.md` before this file. This document answers: **given a Linear issue, which worker binary and which model should implement it?** It replaces `docs/operators/claude-model-selection-policy.md`, generalized from "which Claude model" to "which worker, and which model."

## Decision: cost-optimized, explicit, rubric-driven

Worker and model selection is cost-optimized and rubric-driven, starting from the cheapest capable option and upgrading only when a named condition applies. It requires judgment applied to a concrete rubric, not fully automated selection — a human can always override via the `worker:*` / `model:*` Linear labels, and that override always wins.

## Available workers

Only workers that can execute against a real local git worktree on this Mac are viable dispatch targets:

| Worker | Invocation | Notes |
|---|---|---|
| `claude` | `claude -p --model <id>` | Primary worker. Full local tool access, MCP, worktree-aware |
| `codex` | `codex exec --sandbox workspace-write -c model_reasoning_effort=<tier>` | Secondary worker. Independent quota pool — useful when Claude is throttled, and a real vendor-neutrality check on the worker-adapter interface. See below for the tier→effort/model mapping |

Cursor Cloud Agent and GitHub Copilot coding agent are **not** viable dispatch targets for this pipeline: both execute in a cloud VM with no path to this Mac's worktrees. They may still be useful as an editor/IDE completion tool, but that is a separate decision from this repo's agent-dispatch architecture and is not covered by this document.

### Installing the Codex CLI

Codex is the dispatcher's second worker option, selected via the `worker:codex` Linear label. To use Codex as a dispatch target:

1. **Install** the Codex CLI globally via npm:
   ```sh
   npm i -g @openai/codex
   ```

2. **Verify** the installation by running `dispatcher doctor`, which will report "codex on PATH" as a passing check:
   ```sh
   npm run dispatcher:doctor
   ```
   If the check fails, ensure the global npm bin directory is on your shell's `PATH`.

## Default routing by task shape

| Task shape | Worker | Model tier |
|---|---|---|
| Docs, chores, config, mechanical refactor | either | cheap |
| Small code change: 1–3 files, clear spec | claude (default) | default |
| Multi-file feature, moderate design work | claude (default) | default |
| Ambiguous spec, 5+ interconnected systems, security-sensitive, migration | claude | strong |
| A prior attempt at a lower tier produced a materially incorrect implementation | claude | strong |

"Cheap" / "default" / "strong" map to the current Claude model catalog (see the `claude-api` skill or Anthropic's published model list for exact IDs — this document intentionally does not pin model IDs, since they change over time and pinning them here would require touching this file on every model release).

For Codex, the tier maps to a `model_reasoning_effort` value passed via `-c`, and optionally an explicit `--model` id:

| Tier | `model_reasoning_effort` | `--model` |
|---|---|---|
| `cheap` | `low` | omitted unless `MOVIECAL_CODEX_MODEL_CHEAP` is set |
| `default` | `medium` | omitted unless `MOVIECAL_CODEX_MODEL_DEFAULT` is set |
| `strong` | `high` | omitted unless `MOVIECAL_CODEX_MODEL_STRONG` is set |

So `workerInvocation("codex", "strong")` spawns `codex exec --sandbox workspace-write -c model_reasoning_effort=high`, and adds `--model <id>` only when the corresponding `MOVIECAL_CODEX_MODEL_*` env var is set. With no `--model` flag, Codex falls through to whatever `~/.codex/config.toml` holds for `model`. The effort values above can be overridden the same way as the Claude model table, via `MOVIECAL_CODEX_EFFORT_CHEAP` / `MOVIECAL_CODEX_EFFORT_DEFAULT` / `MOVIECAL_CODEX_EFFORT_STRONG`.

## Upgrade conditions

Moving up a tier requires citing the specific condition, either in the Linear issue's `model:*` label rationale or the issue description. Moving directly to the strong tier requires citing `prior-failure` or `architecture` plus a one-sentence rationale.

| Condition | Meaning |
|---|---|
| `multi-system` | Touches 5+ interconnected systems or modules |
| `ambiguous-spec` | Acceptance criteria require significant inference from incomplete context |
| `security-critical` | Auth, crypto, secrets, or high-stakes production paths |
| `prior-failure` | A previous worker at a lower tier produced a materially incorrect implementation |
| `architecture` | Fundamental design decisions the worker must reason through from first principles |

## Overrides

- `worker:claude` / `worker:codex` — pins the worker binary. Pinned workers are never changed, including by the quota-pool cooldown below.
- `worker:any` — lets the dispatcher pick based on quota availability (see below). The no-label default is **not** `worker:any`: it is a pin to Claude, same as an explicit `worker:claude` label, per the routing table above.
- `model:cheap` / `model:default` / `model:strong` — pins the model tier.

A human-applied label always overrides the default routing table above. There is no silent fallback: if a requested worker or model is unavailable, the dispatcher stops and moves the issue to `Blocked` rather than substituting a different one.

## Worker quota-pool cooldown (MOV-360)

A worker binary's provider usage limit is a fact about that *worker*, not about any one issue. `docs/operators/local-execution.md` §Worktree lifecycle already covers the per-issue side of this (MOV-151/192/205's bounded one-retry-or-resume). This section is the dispatch-wide side: once a worker hits a recognized, reset-bearing provider usage limit, `dispatcher run` pauses dispatch of *every* issue that would use that same worker — pinned or `worker:any` — until the reported reset passes, so one exhausted quota window cannot burn through the rest of the `Ready for Agent` queue one issue at a time, the way it did on 2026-09-25 (`tools/dispatcher/src/worker-cooldown.mjs`).

- **Scope.** Two independent cooldowns, one per worker (`claude`, `codex`), persisted at `~/.config/moviecal/worker-cooldowns.json` (mode 700, alongside the rest of `~/.config/moviecal/`) so a restart does not lose the wait. A cooldown on one worker never affects the other — a Codex-pinned issue (and, per the selection rule below, a fresh `worker:any` issue) keeps dispatching normally while Claude is cooling down, and symmetrically.
- **`worker:any` selection.** A fresh claim (no prior attempt, no retained worktree) picks Claude by default, or Codex when Claude is cooling down; the symmetric case holds when Codex is the preferred worker. Once an issue's attempt has begun, its scheduled retry or MOV-205 retained-worktree resume stays bound to the worker that first attempt actually used — recorded on the same per-issue usage-limit record `usage-limit.mjs` already keeps, and never silently re-picked, even if the other worker is open. If neither worker is available, a fresh `worker:any` issue is left queued without a claim rather than started on a worker it never actually picked.
- **After the reset.** Exactly one issue using the cooled worker is admitted as a probe once its reported reset has passed — preferring a due per-issue retry/resume for that worker over a fresh claim, when one is eligible in the same batch. A clean probe closes the cooldown; a new recognized limit refreshes it to the newly reported reset instead, even when the probing issue itself has exhausted its own one-retry allowance and escalates to `Needs Human Decision`.
- **What it never does.** Gate reconciliation, parent-completion/priority-propagation passes, promotion, or read-only CI observation — all of those keep running during a cooldown. Move an unrelated issue to `Blocked` or `Needs Human Decision` — the cooldown is a dispatch gate, not an escalation. Mask or invent a reset: an unrecognized failure, a credential failure, or a usage-limit message whose reset cannot be trusted (unparseable, or further out than `usage-limit.mjs`'s `MAX_USAGE_LIMIT_DEFERRAL_MS`) never touches the cooldown either way.
- **Operator visibility.** `dispatcher dry-run` prints each worker's live cooldown state (`open` / `COOLING until <reset>` / `PROBE OWED`) and, per issue, the worker it would actually use — including a quota-aware `worker:any` pick or an existing binding — without consuming a probe or writing anything. `dispatcher doctor` reports the same per-worker state as an informational check. Both are read-only views of the same store `dispatcher run` gates on.

## Subagents

When a worker spawns its own subagents (e.g. Claude Code's `Agent` tool), the subagent inherits the parent worker's effective model by default. A subagent may use a different model only when the issue brief explicitly names one for that subagent. This preserves the existing repo-scoped subagent definitions in `.claude/agents/` (`explore`, `code-reviewer`), which intentionally do not pin a model in their frontmatter.

## Changing this policy

Update this file first, then reconcile:

- `docs/operators/local-execution.md` — if the change affects dispatcher behavior
- `tools/dispatcher/` routing logic — the code that actually implements this table
- `.claude/agents/` — if a subagent's model behavior needs to change

## What was deliberately dropped from the previous policy

The previous `claude-model-selection-policy.md` included two mechanisms specific to the retired cloud-agent (CCR) execution model:

- **CCR model-alias substitution** (`sonnet`/`opus`/`haiku` enum aliases resolving to specific model IDs, with a documented workaround for requesting a model the alias couldn't express). This Mac runs the `claude` CLI directly with real model IDs; the alias-resolution problem does not exist locally.
- **The `"default"` is not a valid value / mandatory `Requested Claude model:` field** rule, which existed so a cloud worker with no visibility into the orchestrator's intent wouldn't silently proceed on an unstated model. The local dispatcher always resolves and records an explicit model before spawning a worker, so this is enforced in code rather than by convention.

Both are preserved for reference in `docs/operators/archive/claude-model-selection-policy.md`.
