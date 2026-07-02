# Agent Workflow Contract

This repository is prepared for issue-by-issue agent execution. Read this file first, then confirm the current GitHub Project and issue state before changing code.

## Which platform are you running on?

This file is the generic contract every agent and human contributor reads. Platform-specific detail (bootstrap/config file location, tool availability quirks, branch convention, secrets handling) lives in `docs/operators/` so this file stays short enough to read in full every session.

- Codex (Desktop or CLI): read `docs/operators/codex.md`.
- Cursor Cloud Agent: read `docs/operators/cursor-cloud.md`.
- GitHub Copilot coding agent: read `docs/operators/github-copilot.md`.
- Human contributor, or a platform not listed here: the generic rules below are all you need; see `docs/operators/README.md` if you want to add a guide for a new platform.

## Start conditions

- **Product-track feature work (Codex workers):** start implementation only from the single open GitHub issue whose `moviecal Delivery` project item has `Agent Dispatch = Yes` and `Status = Ready`.
- **Platform-track, governance, or directly assigned work (any platform):** start only when a human assigns the task or delegates the issue; these items keep `Agent Dispatch = No`. See `docs/operators/multi-platform-dispatch-policy.md`.
- Treat the GitHub Project as the operational source of truth for live queue state, status, and ordering.
- Do not start feature work from detached `HEAD`; branch from `master`.
- Branch name format is platform-specific. See `docs/operators/branch-and-ci-conventions.md` for the exact prefix each platform uses; do not rename a platform-assigned branch to match a different platform's convention.
- Governance or queue-maintenance changes should stay separate from feature delivery. Use a `docs/` or `chore/` branch for governance PRs.
- Keep PR scope to one issue unless the issue explicitly says otherwise. After governance changes, update the queue guidance docs and issue templates in the same PR when they change operator behavior.

## Queue authority

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues remain authoritative for background, acceptance criteria, verification steps, security notes, out-of-scope boundaries, and dependency notes.
- The project field `Agent Dispatch` is the dispatch authority surface. `Yes` marks the one issue a fresh implementation agent may start; `No` marks every other issue.
- If project state, issue labels, and planning docs disagree, reconcile the GitHub Project first, then update the issue state, then update docs.

## Required preflight

- Read `.github/copilot-instructions.md` and the docs linked from the selected issue.
- Confirm the issue is still open, unblocked, and still the only issue with `Agent Dispatch = Yes`.
- Confirm that same project item still has `Status = Ready`.
- If the issue has been open across later merged feature work, spot-check current repo state against the live acceptance criteria before starting so stale dispatch candidates are reconciled instead of implemented with a no-op PR.
- Confirm the required environment/tooling for that issue exists before coding.
- Stop and escalate if blocked on secrets, auth, external infrastructure, conflicting issue state, or unclear acceptance criteria.

## Queue governance and the orchestrator/worker contract

The full Codex orchestrator/worker procedure (roles, worktree provisioning, `spawn_agent`, checkpoint gates, detailed post-merge handoff steps, session workflow) lives in `docs/planning/agent-orchestration.md` and `docs/planning/AGENT_GUIDANCE.md`, not in this file. Those documents were intentionally **not** moved into `docs/operators/codex.md` yet — issue **#104** consolidates them after migration cutover (**#95**).

The invariants below apply regardless of which doc currently governs procedural detail:

- A ready handoff means: a local branch tracking `origin/master` contains the merged change; there are no stray open PRs for the same issue; exactly one open issue has `Agent Dispatch = Yes` and `Status = Ready`, unless the queue is intentionally blocked; and the promoted issue has current acceptance criteria, verification steps, and security notes when applicable.
- If the next issue depends on missing tooling, secrets, or infrastructure, mark the queue blocked instead of promoting a speculative dispatch issue.
- When multiple open issues could look ready, use the project `Queue Order` field as the deterministic tie-breaker.
- Multi-platform dispatch rights are documented in `docs/operators/multi-platform-dispatch-policy.md`. Only Codex workers may receive `Agent Dispatch = Yes` for product-track feature delivery; Cursor Cloud Agents and GitHub Copilot implement platform/governance work via direct assignment only.

## Environment policy

- Use disposable or dev-only credentials and resources for Supabase, TMDb, and cron protection.
- Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values and does not mean live integrations are ready.
- Platform-specific environment/tooling details (validated OS support, Docker availability, `gh` auth quirks, the repo-local Supabase/Vercel CLI install path) live in `docs/operators/`. See the router table above for which doc to read.

## Verification contract

- Baseline verification: `npm run verify`
- Production build: `npm run build`
- E2E: `npm run e2e`
- Human local testing should happen on the pushed issue branch before the PR is promoted from draft or work-in-progress to ready for review.
- Each implementation issue should produce an explicit manual testing checklist with setup assumptions, happy-path steps, edge cases, regression checks, and expected results.
- Each implementation issue should either land its intended automated coverage or identify the immediate feature-specific follow-up issue for any deferred Playwright coverage before review handoff.
- Update docs when routes, environment variables, verification commands, or security assumptions change.
- If you change a branch prefix or a CI workflow's `branches:` filter, run `npm run check:branch-ci` (also enforced in `.github/workflows/verify.yml`) to confirm `docs/operators/branch-prefixes.json` and the workflow triggers still agree.

See `docs/planning/agent-environment-compatibility-plan.md` for the full audit of agent/environment-specific artifacts in this repo and the phased plan for keeping multiple agent platforms compatible without breaking each other.
