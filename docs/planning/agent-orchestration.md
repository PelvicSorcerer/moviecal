# Agent orchestration model

This document defines how to let one agent manage queue state while other agents implement individual issues.

## Roles

### Orchestrator

The orchestrator is a governance agent. It does not own product delivery for a feature issue. It owns:

- validating the GitHub queue
- selecting the next dependency-correct issue
- promoting exactly one issue to `agent-ready`
- demoting blocked or superseded issues
- checking handoff state after merge
- producing the worker brief for the next implementation session

### Worker

The worker is an implementation agent. It owns:

- one open `agent-ready` issue
- one branch and one focused PR
- reading the linked docs and repo instructions
- implementing code and docs for that issue only
- running the required verification commands
- reporting blockers instead of improvising around missing prerequisites

## Codex operator tooling scope

- The repo's `.codex/environments` profiles and `.codex/scripts` helpers are supported operator tooling for Codex-based development in this repository.
- Codex Desktop on macOS is the validated operator environment for that tooling.
- Unix-like Codex environments are expected to work, but they are not yet validated in this repo.
- Windows is not yet a validated environment for this tooling.
- Worker provisioning and bootstrap should read the main repo `.codex/environments` profile as the source of truth, even when the worker runs inside a separate git worktree.

## Queue states

Use GitHub labels and issue comments to make the queue machine-readable.

- `agent-ready`: exactly one open issue should have this when the repo is ready for a fresh worker.
- no `agent-ready`: valid only when the queue is intentionally blocked and the blocker is recorded.
- domain labels such as `database`, `auth`, `tests`, `calendar`, `watchlist`, `deployment`, or `tmdb`: use these for routing, not readiness.
- `docs/planning/open-issue-order.json`: the deterministic preferred execution order for the current open implementation queue when multiple issues could otherwise appear ready.

Recommended operational states:

1. `triage`
2. `ready`
3. `in progress`
4. `review`
5. `blocked`
6. `done`

These states can be represented with comments, project fields, or additional labels if you want stronger automation later. The minimum required invariant is still the single open `agent-ready` issue.

## Orchestrator workflow

1. Check the repository default branch and current open PR state from an attached local branch that tracks `origin/master`, such as `orchestrator/live`.
2. Confirm whether an implementation issue just merged or whether the queue is already idle.
3. Inspect open issues against dependency order, issue comments, and blocking notes.
4. Use `docs/planning/open-issue-order.json` to identify the earliest still-open implementation issue, then confirm its blocker notes are clear.
5. If that issue has remained open through later merged feature work, do a quick repo-state spot check against the live acceptance criteria before promotion so stale issues are reconciled instead of handed to a worker.
6. Promote exactly one issue to `agent-ready` only if it is current, unblocked, and small enough for one PR.
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
   - a human local testing checklist to be used once the worker branch is ready for manual verification
   - known constraints or security notes
13. Use `docs/planning/worker-dispatch-prompt.md` as the default worker handoff template so reporting cadence, role boundaries, boot/startup gates, and stop points are explicit.
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

Use `docs/planning/worker-dispatch-prompt.md` when dispatching a worker. It is intentionally operational:

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
5. Re-evaluate the next dependency-correct issue in `docs/planning/open-issue-order.json`.
6. Promote exactly one issue to `agent-ready`, or document the blocker.
7. Update planning or guidance docs only if the merge changed queue assumptions.

## Manual testing checklist source

Use `docs/planning/manual-testing-checklist-template.md` as the default shape for human local verification handoff. The orchestrator may tailor the checklist per issue, but it should always include:

- environment or auth assumptions
- happy-path validation
- edge cases
- regression checks
- expected results
- notes on anything intentionally deferred or known to be flaky

## Failure modes to guard against

### Queue goes empty by accident

This is the failure you just hit. The worker finished, but nobody promoted the next issue. Mitigation:

- make post-merge handoff a required orchestrator step
- use a dedicated handoff check script
- keep the single-issue invariant explicit in repo docs and issue templates

### Multiple issues become ready at once

Mitigation:

- fail queue validation when more than one open issue has `agent-ready`
- require the orchestrator to demote all but one before a fresh worker starts

### Ready issue is not actually dependency-correct

Mitigation:

- compare the issue against `docs/planning/recommended-issue-sequence.md`
- read issue comments for blocker notes before promotion
- spot-check the current repo against the live issue acceptance criteria when the issue may have gone stale through later merged work
- prefer blocking the queue over promoting speculative work

## Minimal automation boundary

You can automate the orchestrator safely when it is limited to:

- reading GitHub issue and PR state
- validating queue invariants
- updating labels/comments
- producing the next worker brief

Keep merge approval, secret provisioning, and priority changes under human control unless you intentionally build stronger safeguards around them.
