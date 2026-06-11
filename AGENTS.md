# Agent Workflow Contract

This repository is prepared for issue-by-issue agent execution. Read this file first, then confirm the current GitHub issue state before changing code.

## Start conditions

- Start implementation only from the single open GitHub issue labeled `agent-ready`.
- Treat GitHub issue state as the operational source of truth when it conflicts with planning docs.
- Do not start feature work from detached `HEAD`; branch from `master`.
- Branch name format: `agent/<issue-number>-<short-slug>`.

## Required preflight

- Read `.github/copilot-instructions.md` and the docs linked from the selected issue.
- Confirm the issue is still open, unblocked, and still the only `agent-ready` issue.
- Confirm the required environment/tooling for that issue exists before coding.
- Stop and escalate if blocked on secrets, auth, external infrastructure, conflicting issue state, or unclear acceptance criteria.

## Environment policy

- Use disposable or dev-only credentials and resources for Supabase, TMDb, and cron protection.
- Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values and does not mean live integrations are ready.
- The repo-local Supabase CLI install path is currently intended for this Apple Silicon macOS environment and should be treated as a local workaround, not a cross-platform project guarantee.

## Verification contract

- Baseline verification: `npm run verify`
- Production build: `npm run build`
- E2E: `npm run e2e`
- Update docs when routes, environment variables, verification commands, or security assumptions change.

## Session workflow

- Use dedicated prep/governance sessions for repo hardening only.
- Use a fresh session for each implementation issue.
- Keep PR scope to one issue unless the issue explicitly says otherwise.
