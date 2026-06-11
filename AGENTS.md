# Agent Workflow Contract

This repository is prepared for issue-by-issue agent execution. Read this file first, then confirm the current GitHub issue state before changing code.

## Start conditions

- Start implementation only from the single open GitHub issue labeled `agent-ready`.
- Treat GitHub issue state as the operational source of truth when it conflicts with planning docs.
- Do not start feature work from detached `HEAD`; branch from `master`.
- Branch name format: `agent/<issue-number>-<short-slug>`.
- Governance or queue-maintenance sessions should branch from `master` with a `docs/` or `chore/` prefix and must not mix feature delivery into the same PR.

## Required preflight

- Read `.github/copilot-instructions.md` and the docs linked from the selected issue.
- Confirm the issue is still open, unblocked, and still the only `agent-ready` issue.
- Confirm the required environment/tooling for that issue exists before coding.
- Stop and escalate if blocked on secrets, auth, external infrastructure, conflicting issue state, or unclear acceptance criteria.

## Orchestrator contract

- Separate the `orchestrator` role from the `worker` role.
- The orchestrator owns queue hygiene: issue triage, dependency checks, `agent-ready` promotion/demotion, and post-merge handoff.
- The worker owns exactly one implementation issue, one focused branch, verification, and PR delivery.
- Do not let a worker session self-assign a second implementation issue after finishing the first. Return control to the orchestrator step first.
- The orchestrator should prefer promoting the next dependency-correct issue immediately after a worker issue lands so the repo never sits in an ambiguous "done but not ready" state.
- If no issue is truly ready, the orchestrator should leave zero `agent-ready` issues and record the blocker explicitly in GitHub.

## Handoff contract

- After an implementation PR merges, check `master`, confirm the merged issue is closed, and reconcile the next queue state before declaring the repo ready again.
- A ready handoff means:
  - `master` contains the merged change.
  - there are no stray open PRs for the same issue.
  - exactly one open issue is labeled `agent-ready`, unless the queue is intentionally blocked.
  - the promoted issue has current acceptance criteria, verification steps, and security notes when applicable.
- If the next issue depends on missing tooling, secrets, or infrastructure, mark the queue blocked instead of promoting a speculative `agent-ready` issue.

## Environment policy

- Use disposable or dev-only credentials and resources for Supabase, TMDb, and cron protection.
- Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values and does not mean live integrations are ready.
- The repo-local Supabase CLI install path is currently intended for this Apple Silicon macOS environment and should be treated as a local workaround, not a cross-platform project guarantee.
- In Codex, GitHub CLI checks may need elevated execution because sandboxed processes may not see the same macOS keychain-backed `gh` login that is available in your normal terminal.

## Verification contract

- Baseline verification: `npm run verify`
- Production build: `npm run build`
- E2E: `npm run e2e`
- Update docs when routes, environment variables, verification commands, or security assumptions change.

## Session workflow

- Use dedicated prep/governance sessions for repo hardening only.
- Use a fresh session for each implementation issue.
- Keep PR scope to one issue unless the issue explicitly says otherwise.
- After governance changes, update the queue guidance docs and issue templates in the same PR when they change operator behavior.
