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

## Queue states

Use GitHub labels and issue comments to make the queue machine-readable.

- `agent-ready`: exactly one open issue should have this when the repo is ready for a fresh worker.
- no `agent-ready`: valid only when the queue is intentionally blocked and the blocker is recorded.
- domain labels such as `database`, `auth`, `tests`, `calendar`, `watchlist`, `deployment`, or `tmdb`: use these for routing, not readiness.

Recommended operational states:

1. `triage`
2. `ready`
3. `in progress`
4. `review`
5. `blocked`
6. `done`

These states can be represented with comments, project fields, or additional labels if you want stronger automation later. The minimum required invariant is still the single open `agent-ready` issue.

## Orchestrator workflow

1. Check the repository default branch and current open PR state.
2. Confirm whether an implementation issue just merged or whether the queue is already idle.
3. Inspect open issues against dependency order, issue comments, and blocking notes.
4. Promote exactly one issue to `agent-ready` only if it is current, unblocked, and small enough for one PR.
5. If no issue qualifies, leave the queue unready and record why.
6. Generate a worker brief with:
   - issue number and title
   - branch naming rule
   - docs to read first
   - exact verification commands
   - known constraints or security notes
7. Use `docs/planning/worker-dispatch-prompt.md` as the default worker handoff template so reporting cadence, role boundaries, and stop points are explicit.

## Worker brief template

Use `docs/planning/worker-dispatch-prompt.md` when dispatching a worker. It is intentionally operational:

- it tells the worker to acknowledge the assignment in its own thread first
- it requires the same checkpoint to be sent back to the orchestrator immediately
- it makes reporting cadence explicit at initial acknowledgment, planned file targets, blockers, ready-for-review, PR-opened, and any orchestrator decision point
- it keeps worker and orchestrator responsibilities separate so the worker does not improvise queue management or additional dispatch work

## Post-merge handoff checklist

Run this after a worker PR lands:

1. Confirm `master` contains the merged work.
2. Confirm the completed issue is closed.
3. Confirm no duplicate or stale PR remains open for the same work.
4. Re-evaluate the next dependency-correct issue.
5. Promote exactly one issue to `agent-ready`, or document the blocker.
6. Update planning or guidance docs only if the merge changed queue assumptions.

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
- prefer blocking the queue over promoting speculative work

## Minimal automation boundary

You can automate the orchestrator safely when it is limited to:

- reading GitHub issue and PR state
- validating queue invariants
- updating labels/comments
- producing the next worker brief

Keep merge approval, secret provisioning, and priority changes under human control unless you intentionally build stronger safeguards around them.
