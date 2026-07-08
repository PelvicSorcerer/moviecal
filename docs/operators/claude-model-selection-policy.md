# Claude model-selection policy

Read `AGENTS.md` and `docs/operators/claude-code.md` before this file. Those documents cover the generic queue contract and the mechanical surfaces (checkpoint fields, dispatch template, fallback error behavior). This document answers the policy question those mechanics left open: **how should the model for a Claude worker session be chosen?**

## Decision: cost-optimized, explicit, and rubric-driven

Model selection is **cost-optimized, explicit, and rubric-driven**. The orchestrator (or issue shaper) must name a specific model ID in every Claude worker issue brief. `"default"` is not a valid value — every issue must specify one of the four supported model IDs from the table below.

The rubric defaults to the cheapest capable model and upgrades only when a named condition applies. It requires human judgment applied to a concrete scoring rubric, not label-driven or fully automated selection.

## A note on effort levels

`output_config.effort` (`low`/`medium`/`high`/`max`/`xhigh`) is an API-level parameter. Claude Code manages it internally for its own requests and does not expose it as a CLI flag. The `Agent` tool has no `effort` parameter. The orchestrator cannot tune effort per-issue in the dispatch brief. **Model selection is the only practical cost lever available to the orchestrator.**

If Claude Code ever exposes effort as a configurable dispatch parameter, `claude-sonnet-4-6` at `max` effort may become a viable substitute for `claude-sonnet-5` at standard effort on some task types. Until then, effort is not a dispatch-time consideration.

## Supported model IDs

| Model ID | Price (in/out per MTok) | Tier |
|---|---|---|
| `claude-haiku-4-5` | $1 / $5 | 1 — cheapest |
| `claude-sonnet-4-6` | $3 / $15 | 2 |
| `claude-sonnet-5` | $3 / $15 (intro $2/$10 through 2026-08-31) | 3 |
| `claude-opus-4-8` | $5 / $25 | 4 — most capable |

`claude-sonnet-4-6` and `claude-sonnet-5` carry the same nominal token price. The tier difference reflects capability: sonnet-5 is more capable and appropriate for tasks where sonnet-4-6 is likely to mis-implement.

## Default model assignments

Start at the cheapest capable model. Use this table as the starting point before applying upgrade conditions.

| Issue type | Default model |
|---|---|
| Docs, policy, governance, issue shaping, chores | `claude-haiku-4-5` |
| Small code change: 1–3 files, clear spec, well-defined tests | `claude-sonnet-4-6` |
| Multi-file feature, moderate architectural reasoning | `claude-sonnet-4-6` |
| Cross-cutting refactor, ambiguous spec, complex state, 5+ interconnected systems | `claude-sonnet-5` |
| Security-sensitive: auth, crypto, secrets, high-stakes production | `claude-sonnet-5` |
| Proven sonnet-5 failure on prior attempt, or hardest architectural work | `claude-opus-4-8` |

## Upgrade conditions

Moving up one tier requires citing the specific condition in the issue brief. Record the condition inline with the model ID (see format below). Moving directly to opus requires citing `prior-failure` or `architecture` plus a one-sentence rationale.

| Condition code | Meaning |
|---|---|
| `multi-system` | Implementation touches 5+ interconnected systems or modules |
| `ambiguous-spec` | Acceptance criteria require significant inference from incomplete context |
| `security-critical` | Auth, crypto, secrets, or high-stakes production paths |
| `prior-failure` | A previous worker at a lower tier produced a materially incorrect implementation |
| `architecture` | Fundamental design decisions the worker must reason through from first principles |

## Worker-session model field format

Every Claude worker issue brief must include a `Requested Claude model:` line with an exact model ID. Two valid formats:

No upgrade (default tier):

```
Requested Claude model: claude-sonnet-4-6
```

Upgrade from default tier (condition required):

```
Requested Claude model: claude-sonnet-5 (upgrade condition: multi-system — touches auth, calendar feed, watchlist, cron, and DB migrations)
```

`"default"` is **not** a valid value. A worker that receives a brief with `default` or no model must stop and report a blocker before doing any substantive work.

## Fallback behavior

There is **no silent fallback**. If the requested model is unavailable (unknown ID, no API access for the tier, retired identifier), the worker must stop immediately and report a blocker before doing any substantive work. The orchestrator must then either re-dispatch with a corrected model or explicitly acknowledge the effective model before allowing work to continue.

A mismatch between `requested_model` and `effective_model` is always a blocker, never a warning to dismiss.

## Subagent model overrides

Subagents spawned by a Claude worker via the `Agent` tool **inherit the parent's effective model by default**.

A subagent may only use a different model when:

1. The worker brief explicitly names a different model for that subagent, or
2. The orchestrator grants explicit written approval mid-session.

Ad-hoc subagent model changes without explicit approval are not permitted. The worker must record `subagent_model` (or `inherited`) in every checkpoint that mentions subagent use.

## Changing this policy

If this policy proves too permissive or too restrictive in practice, update this file first, then reconcile all of the following in the same PR:

- `docs/operators/claude-code.md` — checkpoint fields and model-mismatch rules
- `docs/operators/claude-worker-dispatch-prompt.md` — dispatch template
- `docs/operators/codex-orchestration.md` — orchestrator checklist model-evaluation step
- `.github/ISSUE_TEMPLATE/agent_task.md` — `Requested Claude model:` field and upgrade-condition guidance
- `scripts/lib/project-queue-common.sh` — `project_queue_validate_claude_model_annotation` valid model ID list

Model-selection policy changes that affect checkpoint fields also require updating the checkpoint section in `claude-code.md`.
