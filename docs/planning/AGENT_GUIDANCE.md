# Agent guidance

This repository uses GitHub issues to scope implementation work for humans and automated agents. Use these rules before starting any non-trivial coding task.

## Mandatory preflight checks

- Work from an open GitHub issue unless the maintainer explicitly asks for a docs-only cleanup or planning change.
- Prefer issues labeled `agent-ready`. Treat issues without that label as blocked, deferred, or needing triage before implementation.
- If multiple issues are labeled `agent-ready`, stop and reconcile the queue before handing the repo to a new agent. The default should be exactly one clearly next implementation issue.
- If zero issues are labeled `agent-ready`, treat the repo as not ready for a fresh implementation agent until an orchestrator promotes the next issue or records a blocker.
- Treat current GitHub issue state as authoritative when it conflicts with planning docs.
- If an issue has been open through later merged feature work, spot-check the current repo against the live issue acceptance criteria before implementing it. Close or relabel stale issues instead of producing a no-op PR.
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
- Worker branches should be created inside orchestrator-provisioned git worktrees that are distinct from the orchestrator worktree. Use deterministic issue-centric names so the assigned worktree is easy to validate during startup.
- PR title should use conventional scopes such as `docs:`, `feat:`, `fix:`, `test:`, or `chore:`.
- PR body should link the originating issue when one exists and include the verification commands that were run.

## Queue governance

- Use `agent-ready` only for the single issue that a fresh worker should implement next.
- Re-evaluate `agent-ready` immediately after merge, not only before the next worker starts.
- Prefer one orchestrator session between worker sessions. That session owns queue cleanup, dependency checks, and next-issue promotion.
- Run post-merge orchestrator audits from an attached local branch that tracks `origin/master`; the local branch name does not need to be `master`.
- When no issue is actually ready, leave the queue empty and document the blocker in GitHub instead of forcing a guess.
- Use `bash scripts/agent-check.sh` before worker implementation and `bash scripts/agent-handoff-check.sh` after merge or when auditing repo readiness.

## Codex operator tooling

- The repo's `.codex/environments` profiles and `.codex/scripts` helpers are supported operator tooling for Codex-based development in this repository.
- Codex Desktop on macOS is the validated operator environment for that tooling today.
- Unix-like Codex environments are expected to work, but this repo has not yet validated them.
- Windows support for this tooling is not yet validated.
- Worker worktree bootstrap should resolve from the main repo `.codex/environments` profile as the source of truth, even when the worker executes inside a separate provisioned worktree.

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
2. Run the audit from an attached local branch that tracks `origin/master`, even if the branch name is something like `orchestrator/live`.
3. Confirm the dependency-correct next issue from the current repo and issue state.
4. Ensure exactly one open issue is labeled `agent-ready`, or explicitly record why the queue is blocked.
5. Check that the promoted issue contains docs, acceptance criteria, verification steps, and security notes where needed.
6. Provision the worker through the main repo Codex environment profile, run the worker environment readiness check, and create the assigned git worktree before dispatching the worker.
7. Use `spawn_agent` plus orchestrator-created git worktree isolation as the default worker launch path.
8. Hand the worker a clean brief instead of expecting it to infer sequencing from planning docs alone.
9. When dispatching a worker, include the exact checkpoint mechanism it should use in its own thread, not just a generic instruction to "check in."
10. Use `docs/planning/worker-dispatch-prompt.md` when dispatching a worker so the boot/startup gates, strict worker-thread checkpoints, stop points, and single-issue ownership are explicit.
11. Require the two-step startup contract: `BOOT_CHECKPOINT` from the worker's natural startup context, then `STARTUP_CHECKPOINT` only after the orchestrator explicitly retargets the worker to the assigned worktree.
12. Validate the startup checkpoint against the assigned worktree path and branch before allowing any substantive work to begin.
13. Include a heartbeat interval in the worker brief so the worker reports status proactively if it keeps working without reaching another formal checkpoint.
14. Require strict machine-parseable `REVIEW_CHECKPOINT` and `PUBLISH_CHECKPOINT` blocks so review handoff and publish status can be collected safely through `wait_agent`.
15. While a worker is active, treat `wait_agent` as part of every orchestrator response cycle so worker checkpoints are actively collected rather than passively assumed.
16. Do not stop supervision after one short poll. Continue polling after every substantive worker instruction until the worker reaches the next explicit gate: blocker, review checkpoint, publish checkpoint, or explicit completion.
17. Preserve worker worktrees and branches after publish while review or CI is still running. Clean them up only after merge or explicit abandonment.
18. Once the worker confirms the branch push during publish, verify PR state directly on GitHub instead of waiting only on worker narration.
19. Routine merge decisions for acceptable worker PRs belong to the orchestrator by default unless a maintainer explicitly withholds merge authority or a real blocker needs human judgment.
