# Claude model-selection policy

Read `AGENTS.md` and `docs/operators/claude-code.md` before this file. Those documents cover the generic queue contract and the mechanical surfaces (checkpoint fields, dispatch template, fallback error behavior). This document answers the policy question those mechanics left open: **how should the model for a Claude worker session be chosen?**

## Decision: manual, task-complexity-based

Model selection is **manual and task-complexity-based**. The human orchestrator (or issue shaper) names a model explicitly in the issue brief when the complexity of the work justifies it. All other tasks default to the environment default.

This is not label-driven, cost-tier-driven, or rules-driven automation. The repo is small enough and issue volume low enough that a policy requiring human judgment on each issue is appropriate and preferred over fragile heuristics.

## Worker-session model choice

| Task complexity | Policy |
|---|---|
| Docs, governance, policy, chores, small targeted changes | `requested_model: default` — no explicit model in brief |
| Multi-file feature implementation, architectural changes, large refactors | Orchestrator may specify an explicit model ID in the brief (e.g., `claude-sonnet-5`) |
| Security-sensitive or high-stakes production changes | Orchestrator should specify the most capable current model and document the rationale in the issue |

When no explicit model is stated in the brief, the worker records `requested_model: default` and proceeds on the environment's effective model.

## Fallback behavior

There is **no silent fallback**. If the requested model is unavailable (unknown ID, no API access for the tier, retired identifier), the worker must stop immediately and report a blocker before doing any substantive work. The orchestrator must then either re-dispatch with a corrected model or explicitly acknowledge the effective model before allowing work to continue.

A mismatch between `requested_model` and `effective_model` is always a blocker, never a warning to dismiss.

## Subagent model overrides

Subagents spawned by a Claude worker via the `Agent` tool **inherit the parent's effective model by default**.

A subagent may only use a different model when:

1. The worker brief explicitly names a different model for that subagent, or
2. The orchestrator grants explicit written approval mid-session.

Ad-hoc subagent model changes without explicit approval are not permitted. The worker must record `subagent_model` (or `inherited`) in every checkpoint that mentions subagent use.

## Issue shaping guidance

When shaping an issue that will be dispatched to a Claude worker:

- For straightforward docs/governance work: omit the model field or write `Requested Claude model: default`.
- For complex implementation work where a more capable model is warranted: name the model ID explicitly (e.g., `Requested Claude model: claude-sonnet-5`) and add a one-sentence rationale in the brief.
- Do not specify a model just to be explicit — `default` is a valid and preferred choice for most issues.

## Changing this policy

If this policy proves too permissive or too restrictive in practice, update this file first, then reconcile `docs/operators/claude-code.md`, `docs/operators/claude-worker-dispatch-prompt.md`, and any issue templates in the same PR. Model-selection policy changes that affect checkpoint fields also require updating the checkpoint section in `claude-code.md`.
