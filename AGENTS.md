# Agent Workflow Contract

This repository is prepared for issue-by-issue agent execution. Read this file first, then confirm the current GitHub Project and issue state before changing code.

## Which platform are you running on?

This file is the generic contract every agent and human contributor reads. Platform-specific detail (bootstrap/config file location, tool availability quirks, branch convention, secrets handling) lives in `docs/operators/` so this file stays short enough to read in full every session.

- Codex (Desktop or CLI): read `docs/operators/codex.md`.
- Cursor Cloud Agent: read `docs/operators/cursor-cloud.md`.
- GitHub Copilot coding agent: read `docs/operators/github-copilot.md`.
- Claude Code (CLI, web, IDE, or remote): read `docs/operators/claude-code.md`.
- Human contributor, or a platform not listed here: the generic rules below are all you need; see `docs/operators/README.md` if you want to add a guide for a new platform.

## Start conditions

- **Dispatch-slot work:** start implementation only from the single open GitHub issue whose `moviecal Delivery` project item has `Agent Dispatch = Yes` and `Status = Ready`. Dispatch-slot eligibility is track-specific:
  - `Product` and `Future`: Codex worker handshake only
  - `iOS`: mixed execution; any platform may implement once promoted, but merge readiness is gated by the self-hosted macOS runner
  See `docs/operators/multi-platform-dispatch-policy.md`.
- **Direct assignment (any platform, any track):** start implementation when a human assigns the task or delegates the issue directly to you. The issue keeps `Agent Dispatch = No` — direct assignment does not consume the dispatch slot. You may implement `Product`, `Future`, `Platform`, or governance work when directly assigned. Migration-track items follow the separate restriction in `docs/operators/multi-platform-dispatch-policy.md` (humans only, or agents on explicit human assignment for doc-only items). See the "Direct assignment path" section in `docs/operators/multi-platform-dispatch-policy.md`.
- **Orchestrator role (any platform):** any platform may act as orchestrator — reading queue state, promoting issues, setting `Agent Dispatch = Yes` on the next ready issue, and running post-merge handoff — using its native tool set. The Codex spawn_agent/worktree mechanics are Codex-specific, but the governance lifecycle (queue intake → dispatch promotion → post-merge handoff) is available to every platform. See each platform's operator guide under `docs/operators/` for the platform-specific orchestrator procedure.
- Treat the GitHub Project as the operational source of truth for live queue state, status, and ordering.
- Do not start feature work from detached `HEAD`; branch from `master`.
- Branch name format is platform-specific. See `docs/operators/branch-and-ci-conventions.md` for the exact prefix each platform uses; do not rename a platform-assigned branch to match a different platform's convention.
- Governance or queue-maintenance changes should stay separate from feature delivery. Use a `docs/` or `chore/` branch for governance PRs.
- Keep PR scope to one issue unless the issue explicitly says otherwise. After governance changes, update the queue guidance docs and issue templates in the same PR when they change operator behavior.

## Queue authority

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues remain authoritative for background, acceptance criteria, verification steps, security notes, out-of-scope boundaries, and dependency notes.
- The project field `Agent Dispatch` is the dispatch authority surface. `Yes` marks the one issue a fresh implementation agent may start; `No` marks every other issue.
- The project field `Dependencies` is the authoritative machine-readable blocker surface for queue eligibility. Use the canonical queue algorithm in `docs/operators/codex-orchestration.md`; do not rely on blocker prose when automation needs a definitive answer.
- If project state, issue labels, and planning docs disagree, reconcile the GitHub Project first, then update the issue state, then update docs.

## Required preflight

- Read `.github/copilot-instructions.md` and the docs linked from the selected issue.
- Confirm the issue is still open, unblocked, and still the only issue with `Agent Dispatch = Yes`.
- Confirm that same project item still has `Status = Ready`.
- If the issue has been open across later merged feature work, spot-check current repo state against the live acceptance criteria before starting so stale dispatch candidates are reconciled instead of implemented with a no-op PR.
- Confirm the required environment/tooling for that issue exists before coding.
- Stop and escalate if blocked on secrets, auth, external infrastructure, conflicting issue state, or unclear acceptance criteria.

## Queue governance and the orchestrator/worker contract

The full Codex orchestrator/worker procedure (roles, worktree provisioning, `spawn_agent`, checkpoint gates, detailed post-merge handoff steps, session workflow) lives in `docs/operators/codex-orchestration.md`, not in this file. Each non-Codex platform's orchestrator procedure lives in its own `docs/operators/*.md` guide.

The invariants below apply regardless of which platform governs the queue:

- A ready handoff means: a local branch tracking `origin/master` contains the merged change; there are no stray open PRs for the same issue; exactly one open issue has `Agent Dispatch = Yes` and `Status = Ready`, unless the queue is intentionally blocked; and the promoted issue has current acceptance criteria, verification steps, and security notes when applicable.
- If the next issue depends on missing tooling, secrets, or infrastructure, mark the queue blocked instead of promoting a speculative dispatch issue.
- When multiple open dispatch-eligible issues could look ready, use the project `Queue Order` field as the deterministic tie-breaker. `Queue Order` is global across the project, but only tracks allowed by `docs/operators/multi-platform-dispatch-policy.md` may hold the dispatch slot.
- Use the canonical queue algorithm in `docs/operators/codex-orchestration.md` before promotion: validate dependency syntax, dependency satisfaction, and any live operational gates such as iOS runner availability before assigning the dispatch slot.
- Multi-platform dispatch rights are documented in `docs/operators/multi-platform-dispatch-policy.md`. Any platform may act as orchestrator (promote issues, set `Agent Dispatch = Yes`, run post-merge handoff). Product and Future dispatch-slot work still uses the formal Codex handshake; the iOS track is the mixed-execution exception. See that doc for the full policy and per-platform notes.

## Environment policy

- Use disposable or dev-only credentials and resources for Supabase, TMDb, and cron protection.
- Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values and does not mean live integrations are ready.
- Platform-specific environment/tooling details (validated OS support, Docker availability, `gh` auth quirks, the repo-local Supabase/Vercel CLI install path) live in `docs/operators/`. See the router table above for which doc to read.

## Verification contract

- Testing lanes are defined in `docs/planning/testing-lanes.md`. The default fast pull-request gate is `npm run verify` (baseline, unit, and integration lanes).
- Baseline verification: `npm run lane:baseline` or `npm run verify`
- Unit tests: `npm run lane:unit`
- Deterministic integration tests: `npm run lane:integration`
- Browser E2E: `npm run lane:browser` (alias: `npm run e2e`)
- Real-stack database validation: `npm run lane:real-stack` (alias: `npm run db:lint`; authoritative CI gate: `supabase-verify` workflow)
- Production build: `npm run build` (included in `lane:baseline`)
- Human local testing should happen on the pushed issue branch before the PR is promoted from draft or work-in-progress to ready for review.
- Each implementation issue should produce an explicit manual testing checklist with setup assumptions, happy-path steps, edge cases, regression checks, and expected results. Classify checklist items and recurring regressions using `docs/planning/manual-versus-automated-testing-policy.md`.
- Each implementation issue must include a **Testing Expectations** section that states the expected automated coverage (unit, integration, browser E2E) up front, using `docs/planning/repository-testing-strategy.md` as the capability-to-layer guide. See `.github/ISSUE_TEMPLATE/agent_task.md`.
- Each implementation PR must include a **Test Impact** section that states what tests were added or updated, or why no test changes were needed. See `.github/pull_request_template.md`.
- Deferred automated coverage must reference a concrete follow-up issue number (for example `#NNN`) before review handoff — not a vague note or umbrella backlog reference. Create that follow-up issue when one does not already exist.
- Update docs when routes, environment variables, verification commands, or security assumptions change.
- If you change a branch prefix or a CI workflow's `branches:` filter, run `npm run check:branch-ci` (also enforced in `.github/workflows/verify.yml`) to confirm `docs/operators/branch-prefixes.json` and the workflow triggers still agree.

See `docs/planning/agent-environment-compatibility-plan.md` for the full audit of agent/environment-specific artifacts in this repo and the phased plan for keeping multiple agent platforms compatible without breaking each other.

## Cursor Cloud specific instructions

Read `docs/operators/cursor-cloud.md` first — it is the authoritative operator guide. The notes below are the durable, non-obvious startup/run caveats confirmed on the Cloud Agent VM.

- **Node version (repo policy is Node 24):** the supported Cursor Cloud setup is `.cursor/environment.json` backed by `.cursor/Dockerfile` (`node:24-bookworm`), which makes Node 24 the base and is the source of truth (see `docs/operators/cursor-cloud.md`, "Node version policy"). If a run reports Node 22 from `/exec-daemon/node`, that means the pod booted in Cursor's JIT/default override environment rather than from the repo Docker build (confirmable via the Cloud environment info: `source: Override` / `build: null`), so the Dockerfile never took effect. The durable fix is to remove or update the environment override/snapshot so the run boots from the repo Docker environment — not to patch Node per session. As a last-resort emergency workaround for an already-booted JIT session, `nvm` can raise an interactive shell to Node 24, but this is not a real fix: it does not affect non-interactive exec-daemon commands (which still resolve `/exec-daemon/node`), so never rely on it for CI-equivalent runs.
- **Dev server:** `npm run dev` serves the app on port 3000. `.env.local` (auto-created from `.env.example` by the environment install step) holds placeholder values, so the app boots and the public pages render, but any Supabase-backed surface (sign-in, watchlist, search, calendar settings) intentionally errors with `SupabaseEnvironmentError` / redirects to `/sign-in?error=auth-unavailable` until real disposable Supabase/TMDb secrets are provided via the Secrets tab. This placeholder-driven error is expected, not a setup failure.
- **Testing without secrets:** the browser E2E lane (`npm run lane:browser`) validates full search/watchlist/calendar flows end-to-end using deterministic auth fixtures and Playwright API stubs, so it needs no real Supabase/TMDb secrets. Verification lanes and their commands are already documented in the "Verification contract" section above and in `docs/planning/testing-lanes.md`.
- **Docker/local Supabase:** unavailable on the Cloud Agent VM; use the `supabase-verify` CI workflow or `npm run db:lint` with a disposable `SUPABASE_DB_URL` (see `docs/operators/cursor-cloud.md`).
