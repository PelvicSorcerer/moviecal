# Multi-platform agent dispatch policy

This document is the single source of truth for which agent platforms may receive `Agent Dispatch = Yes` on a `moviecal Delivery` GitHub Project item after the project cutover.

Read `AGENTS.md` first for the generic queue contract.

## Queue authority

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues are authoritative for scoped execution contracts: background, acceptance criteria, verification steps, security notes, dependency notes, and out-of-scope boundaries.
- Exactly one open issue may have `Agent Dispatch = Yes` at any time, and that issue must also have `Status = Ready`. If no such issue exists, the queue is intentionally blocked.
- The `Dependencies` project field is the authoritative machine-readable blocker surface for queue eligibility. Invalid dependency data blocks eligibility and requires human correction.
- The `agent-ready` label is a derived compatibility surface only. After cutover, do not dispatch from labels alone — reconcile project fields first.

## Orchestrator role

Any platform may act as orchestrator: reading queue state, promoting issues, setting `Agent Dispatch = Yes`, and running post-merge handoff.

The mechanics differ by platform, but the lifecycle is the same:

1. Read current queue state.
2. Demote the merged issue (`Agent Dispatch = No`, `Status = Done`).
3. Select the next ready issue by `Queue Order`, then apply dependency and live-gate checks.
4. Promote exactly one issue (`Agent Dispatch = Yes`, `Status = Ready`), or record a blocker.
5. Optionally dispatch or assign a worker for the promoted issue.

See each platform's operator guide for the platform-specific orchestrator procedure:
- Claude Code: `docs/operators/claude-code.md`
- Cursor: `docs/operators/cursor-cloud.md`
- Copilot: `docs/operators/github-copilot.md`
- Codex: `docs/operators/codex-orchestration.md`

## Dispatch-eligible tracks

| Policy category | Live project `Track` values | Dispatch eligible | Worker model | Extra gate |
|---|---|---|---|---|
| Product delivery | `Shared Watchlists`, `Calendar`, `Docs` | Yes | Codex worker handshake | None beyond normal queue eligibility |
| Future | `Future` | Yes | Codex worker handshake | None beyond normal queue eligibility |
| iOS | `iOS` | Yes | Mixed execution | Self-hosted macOS runner must be online and correctly labeled |
| Platform | `Platform` | No | Direct assignment only | n/a |
| Migration | `Migration` | No | Direct assignment only | n/a |

There is no project `Track` option named `Product`. Issue bodies that say `Track = Product` use policy shorthand; orchestrators must map work to a domain track using `docs/planning/project-field-taxonomy.md` and must stop rather than guess when mapping is unclear.

`Future` is not a parking lot for vague ideas. A `Future`-track issue must still have a normal executable issue contract before it can be promoted to `Status = Ready` and receive dispatch.

## Policy summary

| Project `Track` | Who may set `Agent Dispatch = Yes` | Who may start from `Agent Dispatch = Yes` | Who may implement via direct assignment |
|---|---|---|---|
| Product delivery domain tracks | Any platform or human acting as orchestrator | Codex workers only | Any platform or human |
| Future | Any platform or human acting as orchestrator | Codex workers only | Any platform or human |
| iOS | Any platform or human acting as orchestrator | Any platform or human on a promoted issue | Any platform or human |
| Platform | Not applicable | Not applicable | Any platform or human |
| Migration | Not applicable | Not applicable | Humans, or agents only on explicit human assignment for doc-only migration work |

## Dispatch-slot work on product-delivery domain tracks and Future

Only Codex workers may start implementation from the single `Agent Dispatch = Yes` / `Status = Ready` slot when the promoted item is on a product-delivery domain track (`Shared Watchlists`, `Calendar`, `Docs`) or `Future`.

This restriction applies to the worker role only. Any orchestrating platform may set the dispatch slot.

## iOS track

- `iOS` is main-queue eligible once the iOS lane exists.
- iOS work is not permanently direct-assignment-only.
- Execution is mixed: any platform may implement a promoted iOS issue.
- Merge readiness is gated by the self-hosted macOS runner lane.
- Runner availability is checked at promotion time and again immediately before work starts.
- If the runner is unavailable at start-time, remove `Agent Dispatch = Yes`, keep `Status = Ready`, and continue scanning the queue for the next eligible issue.

## Direct assignment path

Any agent platform or human may implement a product-delivery, `Future`, `iOS`, or `Platform` issue when directly assigned, without requiring or competing for the dispatch slot.

Direct assignment means:

- A human explicitly assigns or delegates the issue.
- The issue remains at `Agent Dispatch = No`.
- The implementing agent uses its platform-assigned branch prefix.

Direct assignment does not change the queue invariant that exactly one open issue may have `Agent Dispatch = Yes` at any time.

## Queue Order, eligibility, and skip-forward behavior

`Queue Order` is a global field across the whole board. It expresses the orchestrator's preferred execution sequence, including non-dispatchable items.

When selecting the next dispatchable issue, consider only open issues that are:

1. on a dispatch-eligible project `Track` (`Shared Watchlists`, `Calendar`, `Docs`, `Future`, or `iOS`)
2. `Status = Ready`
3. dependency-valid and dependency-satisfied
4. operationally eligible, including any live runner or tooling gate the issue contract requires
5. small enough for one focused PR

Among those candidates, use the lowest `Queue Order` value as the deterministic tie-breaker.

When a higher-priority issue is not dependency-valid or not operationally eligible, the orchestrator may skip forward to the next valid issue. The orchestrator uses full-queue scanning rather than a bounded skip window.

## Trusted self-hosted iOS execution

- The self-hosted iOS workflow runs only on trusted in-repo branches.
- Fork-triggered execution on the self-hosted Mac is out of scope for the initial policy.
- The branch families allowed to trigger the iOS workflow are documented in `docs/operators/branch-and-ci-conventions.md` and `docs/operators/branch-prefixes.json`.

## Platform-specific notes

### Codex

- May orchestrate any track.
- May consume `Agent Dispatch = Yes` on product-delivery domain tracks and `Future`.
- May implement promoted iOS issues.

### Cursor Cloud Agent

- May orchestrate any track.
- May not consume `Agent Dispatch = Yes` on product-delivery domain tracks or `Future`.
- May implement promoted iOS issues.

### GitHub Copilot coding agent

- May orchestrate any track.
- May not consume `Agent Dispatch = Yes` on product-delivery domain tracks or `Future`.
- May implement promoted iOS issues.

### Claude Code

- May orchestrate any track.
- May not consume `Agent Dispatch = Yes` on product-delivery domain tracks or `Future`.
- May implement promoted iOS issues.

### Governance branch prefixes

Governance and queue-maintenance changes that are not tied to a product implementation issue use `docs/**` or `chore/**` branches. These branches are available to any agent platform or human and do not require `Agent Dispatch = Yes`.

## Post-merge handoff

The following steps apply regardless of which platform ran the orchestrator session:

1. Confirm an attached local branch tracking `origin/master` contains the merged work.
2. Confirm the completed issue is closed and no duplicate or stale PR remains open for the same work.
3. Demote the merged issue: post `/project-update Status=Done AgentDispatch=No` on the issue, or use the platform's equivalent GitHub API call.
4. Scan open issues on dispatch-eligible project tracks with `Status = Ready`, ordered by `Queue Order` ascending, and apply dependency plus live-gate checks.
5. Promote exactly one qualifying issue: post `/project-update Status=Ready AgentDispatch=Yes` on that issue. If no issue qualifies, record the blocker instead.
6. Optionally dispatch or assign a worker for the promoted issue using the platform's native mechanism.

## Project fields used together

| Field | Role in this policy |
|---|---|
| `Track` | Separates dispatch-eligible work (product-delivery domain tracks, `Future`, and `iOS`) from non-dispatchable work (`Platform`, `Migration`) |
| `Agent Dispatch` | `Yes` only on the single dispatch-eligible issue |
| `Status` | The dispatchable issue must be `Ready` |
| `Dependencies` | Hard eligibility gate; invalid data blocks promotion until corrected |
| `Queue Order` | Global preferred execution order; dispatch promotion uses the lowest value among open `Ready` issues on dispatch-eligible tracks |
| `Execution Mode` | `Human` items are never dispatch candidates; `Agent`/`Either` dispatch-eligible items may eventually receive dispatch |

## Automation alignment

- Queue-tooling enforcement for the `Dependencies` field and iOS live-runner gate is tracked separately in issue `#241`.
- Until that follow-up lands, the repo docs define the target policy and the live GitHub Project fields remain the human source of truth for dependency correctness and iOS runner-gated promotion.

## Changing this policy

Update this file first, then reconcile `AGENTS.md`, the relevant `docs/operators/*.md` guides, and any issue templates in the same PR. Run `npm run check:branch-ci` if branch-prefix or workflow tables change.
