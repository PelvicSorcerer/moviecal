# Agent Workflow Contract

This repository is prepared for issue-by-issue agent execution. Read this file first, then confirm current work-item state in Linear before changing code.

## Where work comes from

**Linear is the authoritative control plane** for work-item state, priority, acceptance criteria, dependencies, and agent delegation. GitHub remains authoritative for source control, branches, PRs, CI, code review, and releases. See `docs/governance/linear-information-architecture.md` for the full workspace design and the source-of-truth boundaries between Linear, GitHub, and this repository.

- **Dispatcher-driven work:** the local dispatcher (`docs/operators/local-execution.md`) picks up Linear issues in workflow state `Ready for Agent` that are delegated to it, provisions an isolated git worktree, and runs a worker (Claude Code or Codex — see `docs/operators/worker-routing.md`) against it. You do not need to self-select work from a shared queue; if you were started by the dispatcher, your assignment is already in your brief.
- **Direct assignment:** a human may hand you a specific Linear issue or task directly, outside the dispatcher. Read the issue, confirm its acceptance criteria and Testing Expectations are current, and proceed.
- **Orchestrator role:** any session may act as orchestrator — reading Linear/GitHub state, triaging new issues into `Ready for Agent`, and running post-merge follow-up (confirm merge, confirm the Linear issue closed, check whether the next dependency-correct issue should move to `Ready for Agent`). This role does not require or compete for any special "dispatch slot" — Linear's native delegation and the dispatcher's own concurrency limit (default 2 simultaneous worktrees) are the concurrency controls; there is no single-issue mutex to manage by hand.
- Do not start feature work from detached `HEAD`; branch from `master`.
- Branch prefix conventions live in `docs/operators/branch-prefixes.json`, enforced against CI `branches:` filters by `npm run check:branch-ci`. Use `agent/**` for implementation work, `docs/**` or `chore/**` for governance/maintenance work not tied to a specific issue.
- Keep PR scope to one Linear issue unless it explicitly says otherwise. If a change alters operator behavior, update the governance docs it affects in the same PR.

## Required preflight

- Read `.github/copilot-instructions.md` and the docs linked from the Linear issue.
- Confirm the issue is still in a workable state (not since closed, duplicated, or superseded) and its acceptance criteria still match current repo state — if the issue has been open through later merged work, spot-check the live acceptance criteria before implementing so stale work is reconciled instead of producing a no-op PR.
- Confirm the required environment/tooling for the issue exists before coding (see `docs/operators/local-execution.md` for what's available locally).
- Stop and escalate — move the Linear issue to `Needs Input` or `Needs Human Decision` — if blocked on secrets, auth, external infrastructure, conflicting issue state, or unclear acceptance criteria. See `docs/operators/local-execution.md` §Security model for actions that always require a human.

## Environment policy

- Use disposable or dev-only credentials and resources for Supabase, TMDb, and cron protection.
- Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values and does not mean live integrations are ready.
- Local Mac environment/tooling details (what's installed, credential locations, worktree layout) live in `docs/operators/local-execution.md`.

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
- Each implementation issue must include a **Testing Expectations** section that states the expected automated coverage (unit, integration, browser E2E) up front, using `docs/planning/repository-testing-strategy.md` as the capability-to-layer guide.
- Each implementation PR must include a **Test Impact** section that states what tests were added or updated, or why no test changes were needed, and a `Linear: MOV-NNN` reference. See `.github/pull_request_template.md`.
- Deferred automated coverage must reference a concrete follow-up issue (Linear ID, or a GitHub issue number for externally-filed items) before review handoff — not a vague note or umbrella backlog reference. Create that follow-up issue when one does not already exist.
- Update docs when routes, environment variables, verification commands, or security assumptions change.
- If you change a branch prefix or a CI workflow's `branches:` filter, run `npm run check:branch-ci` (also enforced in `.github/workflows/verify.yml`) to confirm `docs/operators/branch-prefixes.json` and the workflow triggers still agree.

## Historical governance

This repo previously ran a GitHub-Project-centric, multi-cloud-platform agent workflow (a single `Agent Dispatch` slot on a GitHub Project, per-platform operator guides for Codex/Cursor Cloud/GitHub Copilot/Claude Code, and a `/project-update` comment-command automation). That system is being retired in favor of the Linear-based model described above and in `docs/operators/local-execution.md`.

The migration is staged: this file and the docs it points to already describe the target state, but the superseded artifacts (`docs/operators/claude-code.md`, `codex.md`, `cursor-cloud.md`, `github-copilot.md`, `codex-orchestration.md`, `multi-platform-dispatch-policy.md`, the `/project-update` workflow, and related queue-check scripts) are not yet archived or removed — that happens only after the Linear-based path is verified end-to-end (see `docs/planning/decision-log.md` for migration status). Until that decommission lands, **do not follow the old operator guides for current work**; this file and `docs/operators/local-execution.md` / `worker-routing.md` / `docs/governance/linear-information-architecture.md` are authoritative regardless of what those older docs say.
