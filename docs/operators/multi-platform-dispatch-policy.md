# Multi-platform agent dispatch policy

This document is the single source of truth for which tracks and platforms may receive `Agent Dispatch = Yes` on a `moviecal Delivery` GitHub Project item after the project cutover.

Read `AGENTS.md` first for the generic queue contract.

## Queue authority

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues are authoritative for scoped execution contracts: background, acceptance criteria, verification steps, security notes, dependency notes, and out-of-scope boundaries.
- Exactly one open issue may have `Agent Dispatch = Yes` at any time, and that issue must also have `Status = Ready`. If no such issue exists, the queue is intentionally blocked.
- The `Dependencies` project field is the authoritative machine-readable blocker surface for queue eligibility. Invalid dependency data blocks eligibility and requires human correction.
- The `agent-ready` label is a derived compatibility surface only. Do not dispatch from labels alone.

## Orchestrator role

Any platform may act as orchestrator: reading queue state, promoting issues, setting `Agent Dispatch = Yes`, and running post-merge handoff.

## Track policy summary

| Track | May receive `Agent Dispatch = Yes` | Worker model | Extra gate |
|---|---|---|---|
| `Product` | Yes | Codex worker handshake | None beyond normal queue eligibility |
| `Future` | Yes | Codex worker handshake | None beyond normal queue eligibility |
| `iOS` | Yes | Mixed execution | Self-hosted macOS runner must be online/labeled |
| `Platform` | No | Direct assignment only | n/a |
| `Migration` | No | Direct assignment only | n/a |

## Product and Future tracks

- `Product` and `Future` remain dispatch-slot tracks.
- Only Codex workers consume the formal `Agent Dispatch = Yes` handshake on these tracks.
- Other platforms may still implement Product or Future work through direct assignment without consuming the dispatch slot.

## iOS track

- `iOS` is main-queue eligible once the iOS lane exists.
- iOS work is not permanently direct-assignment-only.
- Execution is mixed: any platform may implement a promoted iOS issue.
- Merge readiness is gated by the self-hosted macOS runner lane.
- Runner availability is checked at promotion time and again immediately before work starts.
- If the runner is unavailable at start-time, remove `Agent Dispatch = Yes`, keep `Status = Ready`, and continue scanning the queue for the next eligible issue.

## Platform and Migration tracks

- `Platform` and `Migration` items always keep `Agent Dispatch = No`.
- They may be implemented only by direct assignment.

## Queue order and skip-forward behavior

- `Queue Order` is the default ordering authority across the whole project.
- `Dependencies` is a hard eligibility gate.
- When a higher-priority issue is not dependency-valid or not operationally eligible, the orchestrator may skip forward to the next valid issue.
- The orchestrator uses full-queue scanning rather than a bounded skip window.

## Trusted self-hosted iOS execution

- The self-hosted iOS workflow runs only on trusted in-repo branches.
- Fork-triggered execution on the self-hosted Mac is out of scope for the initial policy.
- The branch families allowed to trigger the iOS workflow are documented in `docs/operators/branch-and-ci-conventions.md` and `docs/operators/branch-prefixes.json`.

## Platform-specific notes

### Codex

- May orchestrate any track.
- May consume `Agent Dispatch = Yes` on `Product` and `Future`.
- May implement promoted iOS issues.

### Cursor Cloud Agent

- May orchestrate any track.
- May not consume `Agent Dispatch = Yes` on `Product` or `Future`.
- May implement promoted iOS issues because iOS is mixed-execution.

### GitHub Copilot coding agent

- May orchestrate any track.
- May not consume `Agent Dispatch = Yes` on `Product` or `Future`.
- May implement promoted iOS issues because iOS is mixed-execution.

### Claude Code

- May orchestrate any track.
- May not consume `Agent Dispatch = Yes` on `Product` or `Future`.
- May implement promoted iOS issues because iOS is mixed-execution.

## Automation alignment

- Queue-tooling enforcement for the new `Dependencies` field and iOS live-runner gate is tracked separately in issue `#241`.
- Until that follow-up lands, the repo docs define the target policy and the GitHub Project fields remain the human source of truth.

## Changing this policy

Update this file first, then reconcile `AGENTS.md`, the relevant `docs/operators/*.md` guides, and any issue templates in the same PR. Run `npm run check:branch-ci` if branch-prefix or workflow tables change.
