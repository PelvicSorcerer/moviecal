# MOV-220: bounded Loop-to-Mac handoff validation

**Validated 2026-09-17.** The
[Moviecal local handoff](https://linear.app/moviecal/loop/moviecal-local-handoff-469ed16a2f46)
Loop is published and enabled. A transition into `Ready for Agent` on the
`Moviecal` team causes the Loop to inspect only that triggering issue. If the
issue is already safe for local execution, the Loop sets only its Linear
delegate to `moviecal-dispatcher`; the existing Mac poller remains the sole
component that can start a worker.

## Active boundary

- The trigger is `Moviecal` issue status changed to `Ready for Agent`.
- The Loop can change only its triggering issue. It has no connectors, web
  search, external synced-issue/comment access, or permission to change other
  issues.
- Eligibility requires exactly one route, `execution:mac`; a complete
  Acceptance Criteria section; a complete Testing Expectations section; no
  unresolved blockers; no `human-only` or `type:coordination` label; and no
  conflicting delegate.
- An issue already delegated to `moviecal-dispatcher` is a replay-safe no-op.
- The only successful handoff mutation is `delegate = moviecal-dispatcher`.
  The Loop may not alter route, readiness, specification, labels, priority,
  assignee, project, relations, or any other issue.
- The instructions explicitly forbid Coding Sessions, Agent Sessions,
  repository/code/GitHub work, `execution:cloud`, and any other agent. No
  Coding Session permission or implementation connector was granted.
- If Linear cannot perform and verify the exact delegate update, the Loop
  moves only the triggering issue to `Needs Human Decision` and posts:

  > MOV-220 handoff could not set or verify Agent = moviecal-dispatcher;
  > manual kickoff remains available. No Coding Session was started and
  > eligibility was not weakened.

The workspace's default per-Loop spend limit is $2 per week. No credit,
billing, integration, or workspace-permission change is authorized by this
handoff. Linear retains the published instructions and run history as the
workspace audit trail.

## Live fixture results

All fixtures were disposable. The two successful draft PRs were closed
without merging after inspection, and all five fixture issues were canceled.
The issue histories, comments, worktree identities, branches, and PRs remain
auditable.

| Fixture | Result |
|---|---|
| Happy path (`MOV-232`, PR [#487](https://github.com/PelvicSorcerer/moviecal/pull/487)) | The Loop delegated the eligible issue; the dispatcher created one worktree, one `agent/MOV-232-*` branch, one worker run, and one draft PR. The final PR diff contained only the requested disposable note. |
| Replay (`MOV-232`) | Moving the already-delegated issue through `Ready for Agent` again produced no second worker, branch, or PR. The retained worktree mutex rejected the repeated local poll, demonstrating the independent dispatcher backstop; the issue was restored for fixture cleanup. |
| Offline recovery (`MOV-233`, PR [#492](https://github.com/PelvicSorcerer/moviecal/pull/492)) | With the launchd service unloaded, the cloud Loop delegated the issue and it remained in `Ready for Agent` with no local artifacts. After the service was loaded, the dispatcher created exactly one worktree, branch, worker run, and draft PR. The final PR diff contained only the requested disposable note. |
| Cancellation (`MOV-234`) | The issue was canceled after Loop delegation but before the Mac restarted. It produced no dispatcher comment, worktree, branch, worker, or PR. |
| Route change (`MOV-235`) | `execution:mac` was replaced by `execution:cloud` after delegation but before restart. The dispatcher created no worktree, branch, worker, or PR and moved the contradictory local delegation to `Needs Human Decision` with its existing precise route-conflict guidance. |
| Delegation removal (`MOV-236`) | Delegation was removed after the Loop handoff but before restart. The dispatcher skipped the issue silently and created no worktree, branch, worker, or PR. |

Both worker runs initially let `npm install` remove the same generated
`package-lock.json` field. Human review restored that line on each disposable
branch before acceptance; the final PR file lists contained only their single
requested fixture documents. This was worker verification drift, not an extra
handoff or dispatch attempt.

The replay produced one Loop run but no extra implementation attempt. The
offline batch demonstrated that Linear state and delegation are the durable
queue: no inbound connection to the Mac was needed, and service recovery
picked up only the issue that still satisfied both route and delegation.

## Manual verification and fallback

Before publication, the human operator reviewed the trigger, permissions,
instruction boundary, default spend cap, and run history. `dispatcher doctor`
passed with Agent Sessions and their receiver disabled; `dispatcher dry-run`
was non-mutating; the launchd process was explicitly stopped and restarted for
the offline drill. The Mac still exposes no public inbound listener. Linear
Coding Sessions and `execution:cloud` delivery remain disabled and isolated in
the deferred-cloud project.

Rollback is one switch: disable **Moviecal local handoff**. The intake Loop,
manual issue editing, deterministic promoter, manual assignment of
`moviecal-dispatcher`, dispatcher polling, Linear comments, and GitHub
reconciliation remain complete. Disabling the handoff neither removes existing
delegation nor starts or stops a worker; a human should review queued
`Ready for Agent` issues with `dispatcher dry-run` before any restart.

