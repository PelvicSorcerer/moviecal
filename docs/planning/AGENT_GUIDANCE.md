# Agent guidance

This repository uses GitHub issues to scope implementation work for humans and automated agents. Use these rules before starting any non-trivial coding task.

## Mandatory preflight checks

- Work from an open GitHub issue unless the maintainer explicitly asks for a docs-only cleanup or planning change.
- Prefer issues labeled `agent-ready`. Treat issues without that label as blocked, deferred, or needing triage before implementation.
- If multiple issues are labeled `agent-ready`, stop and reconcile the queue before handing the repo to a new agent. The default should be exactly one clearly next implementation issue.
- If zero issues are labeled `agent-ready`, treat the repo as not ready for a fresh implementation agent until an orchestrator promotes the next issue or records a blocker.
- Treat current GitHub issue state as authoritative when it conflicts with planning docs.
- The issue should include acceptance criteria and verification steps.
- The issue should be small enough for one focused PR.
- Issues touching auth, database access, calendar feeds, scheduled jobs, or secrets must include a security note.
- Do not start from stale progress notes; verify current repository state and current GitHub issue state.
- Do not start feature work from detached `HEAD`.
- Confirm the required tooling and disposable/dev credentials for the selected issue exist before coding.
- For Supabase or other infra-backed tasks, distinguish agent-safe verification from CI-backed verification before implementation starts.

## Branch and PR conventions

- Branch name: `agent/<issue-number>-<short-description>` when an issue number exists; otherwise use `docs/<short-description>` for docs-only cleanup.
- Branch from the repository default branch.
- PR title should use conventional scopes such as `docs:`, `feat:`, `fix:`, `test:`, or `chore:`.
- PR body should link the originating issue when one exists and include the verification commands that were run.

## Queue governance

- Use `agent-ready` only for the single issue that a fresh worker should implement next.
- Re-evaluate `agent-ready` immediately after merge, not only before the next worker starts.
- Prefer one orchestrator session between worker sessions. That session owns queue cleanup, dependency checks, and next-issue promotion.
- When no issue is actually ready, leave the queue empty and document the blocker in GitHub instead of forcing a guess.
- Use `bash scripts/agent-check.sh` before worker implementation and `bash scripts/agent-handoff-check.sh` after merge or when auditing repo readiness.

## Operator checklist

1. Read `.github/copilot-instructions.md` and the relevant docs for the task.
2. Confirm the issue is still open and not superseded by another issue.
3. Confirm acceptance criteria, verification steps, and security constraints are clear.
4. Keep the PR small and focused; do not combine unrelated backlog items.
5. Run lint, typecheck, tests, and build when available before finishing.
6. Stop and escalate when blocked on secrets, auth setup, GitHub issue conflicts, or external infrastructure that is not already provisioned.

## Verification contract guidance

- Treat `npm run verify` as the baseline agent-safe verification contract unless the issue explicitly says otherwise.
- For Supabase schema work, use `npm run db:lint` when local infrastructure is available, but prefer the `supabase-verify` GitHub Actions workflow as the authoritative infra-backed DB gate for merge decisions.
- Do not block an otherwise-correct sandboxed implementation solely because local Docker or localhost database access is unavailable, as long as the PR documents the limitation and the CI DB gate covers the real execution path.

## Orchestrator checklist

1. Audit open issues and PRs on the default branch.
2. Confirm the dependency-correct next issue from the current repo and issue state.
3. Ensure exactly one open issue is labeled `agent-ready`, or explicitly record why the queue is blocked.
4. Check that the promoted issue contains docs, acceptance criteria, verification steps, and security notes where needed.
5. Hand the worker a clean brief instead of expecting it to infer sequencing from planning docs alone.
6. When dispatching a worker, include the exact checkpoint mechanism it should use in its own thread, not just a generic instruction to "check in."
7. Use `docs/planning/worker-dispatch-prompt.md` when dispatching a worker so the first-step check-in, worker-thread checkpoint reporting, stop points, and single-issue ownership are explicit.
8. Include a heartbeat interval in the worker brief so the worker reports status proactively if it keeps working without reaching another formal checkpoint.
9. While a worker is active, treat `wait_agent` as part of every orchestrator response cycle so worker checkpoints are actively collected rather than passively assumed.
