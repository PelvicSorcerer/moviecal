# Codex orchestrator/worker procedure

Read `AGENTS.md` and `docs/operators/codex.md` first. This document is the single primary home for Codex orchestrator/worker operating procedure after the GitHub Project queue cutover (#95). Platform environment and tooling detail stays in `codex.md`; multi-platform dispatch rights are in `multi-platform-dispatch-policy.md`.

## Roles

### Orchestrator

The orchestrator is a governance agent. It does not own product delivery for a feature issue. It owns:

- validating the GitHub Project queue
- selecting the next dependency-correct issue
- setting `Status`, `Queue Order`, and `Agent Dispatch` on queue issues
- demoting blocked or superseded issues
- checking handoff state after merge
- producing the worker brief for the next implementation session

### Worker

The worker is an implementation agent. It owns:

- one open issue selected by the GitHub Project dispatch slot
- one branch and one focused PR
- reading the linked docs and repo instructions
- implementing code and docs for that issue only
- running the required verification commands
- reporting blockers instead of improvising around missing prerequisites

## Queue states

Use the GitHub Project to make the queue machine-readable.

- `Agent Dispatch = Yes`: exactly one open issue should have this when the repo is ready for a fresh worker.
- no open issue with `Agent Dispatch = Yes`: valid only when the queue is intentionally blocked and the blocker is recorded.
- `Status`: use `Backlog`, `Ready`, `In Progress`, `Review`, `Blocked`, and `Done` for workflow state.
- `Queue Order`: the deterministic preferred execution order across the whole project. When promoting the next dispatch issue, filter to open `Ready` issues on dispatch-eligible tracks (`Product` or `Future`) and use the lowest `Queue Order` as the tie-breaker.
- domain labels such as `database`, `auth`, `tests`, `calendar`, `watchlist`, `deployment`, or `tmdb`: use these for routing, not readiness.

Recommended operational states:

1. `triage`
2. `ready`
3. `in progress`
4. `review`
5. `blocked`
6. `done`

These states are represented in project fields. The minimum required invariant is still a single open dispatch issue.

## Mandatory preflight checks (worker)

- Work from an open GitHub issue unless the maintainer explicitly asks for a docs-only cleanup or planning change.
- Prefer the single open issue whose project item has `Agent Dispatch = Yes` and `Status = Ready`. Treat issues without that project state as blocked, deferred, or needing triage before implementation.
- If multiple open issues have `Agent Dispatch = Yes`, stop and reconcile the queue before handing the repo to a new agent. The default should be exactly one clearly next implementation issue.
- If zero open issues have `Agent Dispatch = Yes`, treat the repo as not ready for a fresh implementation agent until an orchestrator promotes the next issue or records a blocker.
- Treat current GitHub Project state as authoritative for queue status and ordering when it conflicts with planning docs.
- Treat forward-looking strategy docs (for example `target-state` slice maps) as non-executable input until converted into scoped GitHub issues.
- If an issue has been open through later merged feature work, spot-check the current repo against the live issue acceptance criteria before implementing it. Close or relabel stale issues instead of producing a no-op PR.
- The issue should include acceptance criteria and verification steps.
- The issue should include a **Testing Expectations** section that states expected automated coverage up front. See `docs/planning/repository-testing-strategy.md` and `.github/ISSUE_TEMPLATE/agent_task.md`.
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
- PR body should link the originating issue when one exists, include a **Test Impact** section (see `.github/pull_request_template.md`), and list the verification commands that were run.
- Deferred automated coverage must reference a concrete follow-up issue number in the PR **Test Impact** section — not a vague backlog note.

## Queue governance

- Use `Agent Dispatch = Yes` only for the single issue that a fresh worker should implement next.
- Re-evaluate project dispatch state immediately after merge, not only before the next worker starts.
- Prefer one orchestrator session between worker sessions. That session owns queue cleanup, dependency checks, and next-issue promotion.
- Run post-merge orchestrator audits from an attached local branch that tracks `origin/master`; the local branch name does not need to be `master`.
- When no issue is actually ready, leave the queue empty and document the blocker in GitHub instead of forcing a guess.
- Use `bash scripts/agent-check.sh` before worker implementation and `bash scripts/agent-handoff-check.sh` after merge or when auditing repo readiness. `agent-check` requires exactly one open issue with `Agent Dispatch = Yes` and `Status = Ready`. `agent-handoff` and `project-queue-check` also accept an intentionally blocked queue with zero dispatchable issues.
- Only Codex workers may receive `Agent Dispatch = Yes` on dispatch-eligible tracks (`Product` or `Future`). See `multi-platform-dispatch-policy.md`.

## Orchestrator workflow

1. Check the repository default branch and current open PR state from an attached local branch that tracks `origin/master`, such as `orchestrator/live`.
2. Confirm whether an implementation issue just merged or whether the queue is already idle.
3. Inspect open issues against project order, issue comments, and blocking notes.
4. Use the project `Queue Order` field to identify the earliest still-open dispatch-eligible issue (`Product` or `Future`) with `Status = Ready`, then confirm its blocker notes are clear.
5. If that issue has remained open through later merged feature work, do a quick repo-state spot check against the live acceptance criteria before promotion so stale issues are reconciled instead of handed to a worker.
6. Set `Agent Dispatch = Yes` on exactly one issue only if it is current, unblocked, small enough for one PR, and still has `Status = Ready`.
7. If no issue qualifies, leave the queue unready and record why.
8. Provision the worker through the main repo Codex environment profile, run the worker environment readiness check, and create a deterministic issue-centric worktree that is clearly separate from the orchestrator worktree.
9. Launch the worker with `spawn_agent`, let it boot naturally, and collect `BOOT_CHECKPOINT` from that natural startup context before retargeting anything.
10. Retarget the worker to the assigned worktree path and assigned branch, then require `STARTUP_CHECKPOINT` before the worker reads docs, edits files, or starts substantive work.
11. Validate the startup checkpoint against the assigned worktree path and branch through the local wrapper or script gate used for worker dispatch. If either value does not match, stop and correct the assignment before continuing.
12. Generate a worker brief with:
   - issue number and title
   - assigned worktree path and assigned branch
   - branch naming rule
   - docs to read first
   - exact verification commands
   - the issue's **Testing Expectations** (expected unit, integration, and browser E2E coverage, plus any deferred-coverage follow-up issue)
   - a human local testing checklist to be used once the worker branch is ready for manual verification
   - known constraints or security notes
13. Use `docs/operators/codex-worker-dispatch-prompt.md` as the default worker handoff template so reporting cadence, role boundaries, boot/startup gates, and stop points are explicit.
14. Include the exact checkpoint mechanism the worker should use in its own thread so it does not have to guess how to surface status.
15. Require strict machine-parseable `REVIEW_CHECKPOINT` and `PUBLISH_CHECKPOINT` blocks in the worker brief.
16. Include a heartbeat interval so the worker reports progress proactively instead of waiting to be asked for status.
17. While any worker is active, every orchestrator response cycle should include an explicit `wait_agent` step before concluding the turn or deciding that no update is available.
18. Continue the supervision loop after every substantive worker instruction until the worker reaches the next real gate: blocker, review checkpoint, publish checkpoint, or explicit completion.
19. Run post-merge handoff checks from an attached local branch that tracks `origin/master`; the branch name may be `master`, `orchestrator/live`, or another local name.
20. Preserve the worker branch and worktree after publish while PR review or CI is still in progress. Clean them up only after merge or explicit abandonment.
21. Routine merge decisions for acceptable worker PRs belong to the orchestrator by default unless the maintainer explicitly withholds merge authority or the PR raises a blocker that genuinely needs human judgment.

## Human local testing loop

Manual local testing is part of issue completion, not a later separate phase.

1. The worker implements the issue and runs the required automated verification.
2. The worker emits a ready-for-review checkpoint in its own thread, including an issue-specific manual testing checklist for orchestrator collection via `wait_agent`.
3. The orchestrator collects that checkpoint with `wait_agent` and asks the human tester to test the current pushed worker branch.
4. The human tester runs the checklist against that pushed worker-owned issue branch.
5. Bugs found during that pass are fixed on the same worker-owned issue branch before the PR is promoted to ready for review.
6. A draft PR may exist before or during this loop for visibility, but the branch should not be treated as review-ready until the checklist either passes or has explicit follow-up notes.

## Worker brief template

Use `docs/operators/codex-worker-dispatch-prompt.md` when dispatching a Codex worker. Use `docs/operators/claude-worker-dispatch-prompt.md` when dispatching a Claude Code worker — it adds the required `Requested Claude model` field and model-checkpoint fields; see `docs/operators/claude-code.md` for the full model-aware dispatch contract. It is intentionally operational:

- it tells the worker to acknowledge the assignment in its own thread first
- it requires `BOOT_CHECKPOINT` from the worker's natural startup context and `STARTUP_CHECKPOINT` only after explicit retargeting to the assigned worktree
- it requires checkpoints to be emitted in the worker thread immediately for orchestrator collection
- it makes reporting cadence explicit at initial acknowledgment, planned file targets, blockers, ready-for-review, PR-opened, and any orchestrator decision point
- it requires strict machine-parseable `REVIEW_CHECKPOINT` and `PUBLISH_CHECKPOINT` blocks
- it requires proactive heartbeat updates when the worker is still active but has not yet reached another formal checkpoint
- it keeps worker and orchestrator responsibilities separate so the worker does not improvise queue management or additional dispatch work
- manual-testing additions do not change the reporting destination; the worker still reports in its own thread and the orchestrator still collects with `wait_agent`

## Active wait loop

When a worker is in flight, the orchestrator should not rely on passive visibility into worker progress.

- The worker emits checkpoints in its own thread.
- The orchestrator collects those checkpoints with `wait_agent`.
- Every orchestrator response while a worker is active should include a `wait_agent` call unless the worker has already reached a final stop point and no longer needs supervision.
- Do not stop after one immediate poll or one short follow-up read. Continue polling after every substantive worker instruction until the worker reaches the next explicit gate: blocker, review checkpoint, publish checkpoint, or explicit completion.
- Do not send a definitive final-style status response while the worker is still active unless the orchestrator is genuinely blocked and needs human input.
- Heartbeat intervals in the worker brief should guide how long the orchestrator waits before polling again.
- Once the worker confirms the branch push during publish, treat publish as GitHub-led: verify the PR directly on GitHub instead of waiting only on the worker thread to narrate the final publish state.

## Post-merge handoff checklist

Run this after a worker PR lands:

1. Confirm an attached local branch tracking `origin/master` contains the merged work.
2. Confirm the completed issue is closed.
3. Confirm no duplicate or stale PR remains open for the same work.
4. Clean up the worker branch and worktree only after merge or explicit abandonment.
5. Re-evaluate the next dependency-correct issue in the project by `Queue Order`.
6. Promote exactly one issue to `Agent Dispatch = Yes`, or document the blocker.
7. Update planning or guidance docs only if the merge changed queue assumptions.

## Manual testing checklist source

Use `docs/planning/manual-testing-checklist-template.md` as the default shape for human local verification handoff. Classify checklist items with `docs/planning/manual-versus-automated-testing-policy.md` so temporary-manual checks do not replace automation on stable surfaces. The orchestrator may tailor the checklist per issue, but it should always include:

- environment or auth assumptions
- happy-path validation
- edge cases
- regression checks
- expected results
- notes on anything intentionally deferred or known to be flaky

## Failure modes to guard against

### Queue goes empty by accident

The worker finished, but nobody promoted the next issue. Mitigation:

- make post-merge handoff a required orchestrator step
- use a dedicated handoff check script
- keep the single-issue invariant explicit in repo docs and issue templates

### Multiple issues become ready at once

Mitigation:

- fail queue validation when more than one open issue has `Agent Dispatch = Yes`
- require the orchestrator to demote all but one before a fresh worker starts

### Ready issue is not actually dependency-correct

Mitigation:

- compare the issue against `docs/planning/recommended-issue-sequence.md`
- read issue comments for blocker notes before promotion
- spot-check the current repo against the live issue acceptance criteria when the issue may have gone stale through later merged work
- prefer blocking the queue over promoting speculative work

## Operator checklist (worker)

1. Read `.github/copilot-instructions.md` and the relevant docs for the task.
2. Confirm the issue is still open and not superseded by another issue.
3. Confirm acceptance criteria, verification steps, and security constraints are clear.
4. Keep the PR small and focused; do not combine unrelated backlog items.
5. Run lint, typecheck, tests, and build when available before finishing.
6. Stop and escalate when blocked on secrets, auth setup, GitHub issue conflicts, or external infrastructure that is not already provisioned.

## Orchestrator checklist

1. Audit open issues and PRs on the default branch.
2. Run the audit from an attached local branch that tracks `origin/master`, even if the branch name is something like `orchestrator/live`.
3. Confirm the dependency-correct next issue from the current repo and issue state.
4. Ensure exactly one open issue has `Agent Dispatch = Yes` and `Status = Ready`, or explicitly record why the queue is blocked.
5. Check that the promoted issue contains docs, acceptance criteria, verification steps, and security notes where needed.
6. Provision the worker through the main repo Codex environment profile, run the worker environment readiness check, and create the assigned git worktree before dispatching the worker.
7. Use `spawn_agent` plus orchestrator-created git worktree isolation as the default worker launch path.
8. Hand the worker a clean brief instead of expecting it to infer sequencing from planning docs alone.
9. When dispatching a worker, include the exact checkpoint mechanism it should use in its own thread, not just a generic instruction to "check in."
10. Use `docs/operators/codex-worker-dispatch-prompt.md` when dispatching a worker so the boot/startup gates, strict worker-thread checkpoints, stop points, and single-issue ownership are explicit.
11. Require the two-step startup contract: `BOOT_CHECKPOINT` from the worker's natural startup context, then `STARTUP_CHECKPOINT` only after the orchestrator explicitly retargets the worker to the assigned worktree.
12. Validate the startup checkpoint against the assigned worktree path and branch before allowing any substantive work to begin.
13. Include a heartbeat interval in the worker brief so the worker reports status proactively if it keeps working without reaching another formal checkpoint.
14. Require strict machine-parseable `REVIEW_CHECKPOINT` and `PUBLISH_CHECKPOINT` blocks so review handoff and publish status can be collected safely through `wait_agent`.
15. While a worker is active, treat `wait_agent` as part of every orchestrator response cycle so worker checkpoints are actively collected rather than passively assumed.
16. Do not stop supervision after one short poll. Continue polling after every substantive worker instruction until the worker reaches the next explicit gate: blocker, review checkpoint, publish checkpoint, or explicit completion.
17. Preserve worker worktrees and branches after publish while review or CI is still running. Clean them up only after merge or explicit abandonment.
18. Once the worker confirms the branch push during publish, verify PR state directly on GitHub instead of waiting only on worker narration.
19. Routine merge decisions for acceptable worker PRs belong to the orchestrator by default unless a maintainer explicitly withholds merge authority or a real blocker needs human judgment.

## Verification contract guidance

- Treat `npm run verify` as the baseline agent-safe verification contract unless the issue explicitly says otherwise. See `docs/planning/testing-lanes.md` for individual lane commands.
- For Supabase schema work, use `npm run lane:real-stack` (alias: `npm run db:lint`) when local infrastructure is available, but prefer the `supabase-verify` GitHub Actions workflow (`lane-real-stack` job) as the authoritative infra-backed DB gate for merge decisions.
- Do not block an otherwise-correct sandboxed implementation solely because local Docker or localhost database access is unavailable, as long as the PR documents the limitation and the CI DB gate covers the real execution path.

## Minimal automation boundary

You can automate the orchestrator safely when it is limited to:

- reading GitHub issue and PR state
- validating queue invariants
- updating labels/comments
- producing the next worker brief

Keep merge approval, secret provisioning, and priority changes under human control unless you intentionally build stronger safeguards around them.
