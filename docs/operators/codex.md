# Codex operator guide

Read `AGENTS.md` and `.github/copilot-instructions.md` before starting work.

## Queue model

- Use the `moviecal Delivery` GitHub Project as the live queue source of truth.
- Start implementation only from the single open issue whose project item has `Agent Dispatch = Yes` and `Status = Ready`.
- Use the project `Queue Order` field when multiple issues could plausibly become the next dispatch candidate.
- Use the GitHub issue body as the execution contract for acceptance criteria, verification steps, security notes, and dependency details.
- Treat `agent-ready` only as a derived compatibility label while the remaining migration cleanup is underway.

## Codex-specific operating notes

- The repo's `.codex/environments` profiles and `.codex/scripts` helpers are the supported Codex operator tooling for this repository.
- Codex Desktop on macOS is the validated operator environment for that tooling today.
- Worker worktree bootstrap should resolve from the main repo `.codex/environments` profile as the source of truth, even when the worker executes inside a separate provisioned worktree.
- The Codex orchestrator/worker model, including `spawn_agent`, worktree provisioning, `BOOT_CHECKPOINT`, `STARTUP_CHECKPOINT`, `REVIEW_CHECKPOINT`, and `PUBLISH_CHECKPOINT`, remains the Codex-specific operating procedure for implementation work in this repo.

## Compatibility notes

- Some legacy scripts still validate migration-era compatibility surfaces such as `agent-ready`. Use those scripts as consistency checks, not as the authority for dispatch selection.
- If the GitHub Project, issue labels, and planning docs disagree, reconcile the project first, then the compatibility state, then the docs.
