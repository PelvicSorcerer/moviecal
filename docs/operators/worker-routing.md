# Worker and model routing policy

Read `AGENTS.md` and `docs/operators/local-execution.md` before this file. This document answers: **given a Linear issue, which worker binary and which model should implement it?** It replaces `docs/operators/claude-model-selection-policy.md`, generalized from "which Claude model" to "which worker, and which model."

## Decision: cost-optimized, explicit, rubric-driven

Worker and model selection is cost-optimized and rubric-driven, starting from the cheapest capable option and upgrading only when a named condition applies. It requires judgment applied to a concrete rubric, not fully automated selection — a human can always override via the `worker:*` / `model:*` Linear labels, and that override always wins.

## Available workers

Only workers that can execute against a real local git worktree on this Mac are viable dispatch targets:

| Worker | Invocation | Notes |
|---|---|---|
| `claude` | `claude -p --model <id>` | Primary worker. Full local tool access, MCP, worktree-aware |
| `codex` | `codex exec --sandbox workspace-write` | Secondary worker. Independent quota pool — useful when Claude is throttled, and a real vendor-neutrality check on the worker-adapter interface |

Cursor Cloud Agent and GitHub Copilot coding agent are **not** viable dispatch targets for this pipeline: both execute in a cloud VM with no path to this Mac's worktrees. They may still be useful as an editor/IDE completion tool, but that is a separate decision from this repo's agent-dispatch architecture and is not covered by this document.

## Default routing by task shape

| Task shape | Worker | Model tier |
|---|---|---|
| Docs, chores, config, mechanical refactor | either | cheap |
| Small code change: 1–3 files, clear spec | claude (default) | default |
| Multi-file feature, moderate design work | claude (default) | default |
| Ambiguous spec, 5+ interconnected systems, security-sensitive, migration | claude | strong |
| A prior attempt at a lower tier produced a materially incorrect implementation | claude | strong |

"Cheap" / "default" / "strong" map to the current Claude model catalog (see the `claude-api` skill or Anthropic's published model list for exact IDs — this document intentionally does not pin model IDs, since they change over time and pinning them here would require touching this file on every model release). Codex tasks use `codex`'s equivalent effort/model setting where available.

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

- `worker:claude` / `worker:codex` / `worker:any` — pins the worker binary. `worker:any` lets the dispatcher pick based on quota availability.
- `model:cheap` / `model:default` / `model:strong` — pins the model tier.

A human-applied label always overrides the default routing table above. There is no silent fallback: if a requested worker or model is unavailable, the dispatcher stops and moves the issue to `Blocked` rather than substituting a different one.

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
