# Agent guidance

This repository uses GitHub issues to scope implementation work for humans and automated agents. Use these rules before starting any non-trivial coding task.

## Mandatory preflight checks

- Work from an open GitHub issue unless the maintainer explicitly asks for a docs-only cleanup or planning change.
- Prefer issues labeled `agent-ready`. Treat issues without that label as blocked, deferred, or needing triage before implementation.
- If multiple issues are labeled `agent-ready`, stop and reconcile the queue before handing the repo to a new agent. The default should be exactly one clearly next implementation issue.
- Treat current GitHub issue state as authoritative when it conflicts with planning docs.
- The issue should include acceptance criteria and verification steps.
- The issue should be small enough for one focused PR.
- Issues touching auth, database access, calendar feeds, scheduled jobs, or secrets must include a security note.
- Do not start from stale progress notes; verify current repository state and current GitHub issue state.
- Do not start feature work from detached `HEAD`.
- Confirm the required tooling and disposable/dev credentials for the selected issue exist before coding.

## Branch and PR conventions

- Branch name: `agent/<issue-number>-<short-description>` when an issue number exists; otherwise use `docs/<short-description>` for docs-only cleanup.
- Branch from the repository default branch.
- PR title should use conventional scopes such as `docs:`, `feat:`, `fix:`, `test:`, or `chore:`.
- PR body should link the originating issue when one exists and include the verification commands that were run.

## Operator checklist

1. Read `.github/copilot-instructions.md` and the relevant docs for the task.
2. Confirm the issue is still open and not superseded by another issue.
3. Confirm acceptance criteria, verification steps, and security constraints are clear.
4. Keep the PR small and focused; do not combine unrelated backlog items.
5. Run lint, typecheck, tests, and build when available before finishing.
6. Stop and escalate when blocked on secrets, auth setup, GitHub issue conflicts, or external infrastructure that is not already provisioned.
