# Multi-platform agent dispatch policy

This document is the single source of truth for which agent platforms may receive `Agent Dispatch = Yes` on a `moviecal Delivery` GitHub Project item after the project cutover (#92–#95).

Read `AGENTS.md` first for the generic queue contract. This policy answers the platform-specific question left open during the agent-environment compatibility refactor (Phase 5, issue **#102**) and reconciles live project usage of `Track = Future` (issue **#147**).

## Queue authority (unchanged)

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues are authoritative for scoped execution contracts: background, acceptance criteria, verification steps, security notes, dependency notes, and out-of-scope boundaries.
- Exactly one open issue may have `Agent Dispatch = Yes` at any time, and that issue must also have `Status = Ready`. If no such issue exists, the queue is intentionally blocked.
- The `agent-ready` label is a derived compatibility surface only. After cutover, do not dispatch from labels alone — reconcile project fields first.

## Dispatch-eligible tracks

Two project tracks may hold the single dispatch slot when intentionally promoted:

| Track | Meaning | Dispatch eligible |
|---|---|---|
| **Product** | User-facing feature delivery | **Yes** — Codex workers only |
| **Future** | Executable non-product workstreams (testing programs, architecture hardening, strategic infrastructure) | **Yes** — Codex workers only |
| **Platform** | Compatibility, governance, process | **No** — always `Agent Dispatch = No` |
| **Migration** | Cutover work | **No** — always `Agent Dispatch = No` |

`Future` is not a parking lot for vague ideas. A `Future`-track issue must still have a normal executable issue contract (acceptance criteria, verification steps, **Testing Expectations**, relevant docs) before it can be promoted to `Status = Ready` and receive dispatch.

## Policy summary

| Project `Track` | Who may receive `Agent Dispatch = Yes` | Who may implement via direct assignment |
|---|---|---|
| **Product** (feature delivery) | **Codex workers only** | Any platform or human (when directly assigned, without requiring the dispatch slot) |
| **Future** (non-product executable workstreams) | **Codex workers only** | Any platform or human (when directly assigned, without requiring the dispatch slot) |
| **Platform** (compatibility, governance, process) | **Nobody** — always `Agent Dispatch = No` | Any platform or human via direct assignment |
| **Migration** (cutover work) | **Nobody** — always `Agent Dispatch = No` | Humans (or agents on explicit human assignment for doc-only migration items) |

### Dispatch-slot work (Product and Future tracks)

Only **Codex workers** may start implementation from the single `Agent Dispatch = Yes` / `Status = Ready` slot, regardless of whether the promoted issue is on `Product` or `Future`.

Rationale:

- This repo's dispatch-slot operating model is a Codex orchestrator/worker contract: the orchestrator promotes issues, sets project dispatch fields, provisions worker worktrees, and validates checkpoint gates. See `codex-orchestration.md` and `codex.md`.
- The dispatch slot exists to give exactly one fresh Codex worker a deterministic start signal. Other platforms do not participate in that handshake.

Codex workers use `agent/<issue-number>-<short-slug>` branches. The Codex orchestrator uses `orchestrator/live` (or similar) and does not consume the dispatch slot for feature work.

### Direct assignment path (Product and Future tracks)

Any agent platform (Claude Code, Cursor Cloud Agent, GitHub Copilot) or human may implement a **Product** or **Future** track issue when **directly assigned by a human**, without requiring or competing for the dispatch slot. Direct assignment means:

- A human (engineer, lead, or orchestrator) explicitly assigns the issue to a specific agent or delegates the issue to them.
- The issue remains at `Agent Dispatch = No` — it does not consume the single dispatch slot.
- The implementing agent uses its platform-assigned branch prefix (e.g., `claude/**` for Claude Code, `cursor/**` for Cursor, `copilot/**` for Copilot).

**This is distinct from dispatch-slot work:** the slot is a Codex-only formal handshake where an orchestrator promotes exactly one issue and provisions a worker. Direct assignment is a lightweight human-initiated alternative available to every platform on every track.

Direct assignment does not affect the queue invariant that exactly one open issue may have `Agent Dispatch = Yes` at any time.

### Platform-track and governance work

Platform-track issues (`Track = Platform`, including compatibility issues **#102–#106**) always keep `Agent Dispatch = No`. They are not eligible for the dispatch slot regardless of platform.

Any agent platform or human may implement platform-track or governance work when **directly assigned** — for example:

- a Cursor Cloud Agent task such as "handle issue #102"
- a GitHub issue delegated to Copilot
- a human opening a `docs/**` or `chore/**` PR

Direct assignment is not the same as consuming `Agent Dispatch = Yes`. Agents on direct assignment must not set, assume, or compete for the dispatch slot.

### Cursor Cloud Agent

- **May not** receive `Agent Dispatch = Yes` on any project item.
- **May** implement Product, Future, Platform, or other work when a human assigns them directly (see "Direct assignment path" above).
- Uses `cursor/<slug>-<run-id>` branches (platform-assigned). See `docs/operators/cursor-cloud.md`.

### GitHub Copilot coding agent

- **May not** receive `Agent Dispatch = Yes` on any project item.
- **May** implement Product, Future, Platform, or other work when a human assigns them directly, or when GitHub assigns an issue or PR to Copilot (see "Direct assignment path" above).
- Uses `copilot/**` branches (platform-assigned). See `docs/operators/github-copilot.md`.

### Governance branch prefixes

Governance and queue-maintenance changes that are not tied to a product implementation issue use `docs/**` or `chore/**` branches. These branches are available to any agent platform or human and do not require `Agent Dispatch = Yes`. See `docs/operators/branch-and-ci-conventions.md`.

## Queue Order and dispatch promotion

`Queue Order` is a **global** field across every project item. It expresses the orchestrator's preferred execution sequence for the whole board, including `Platform`, `Migration`, and non-dispatchable items.

Dispatch promotion uses a narrower filter. When selecting the next dispatchable issue, consider only open issues that are:

1. on a dispatch-eligible track (`Product` or `Future`)
2. `Status = Ready`
3. unblocked, with a current executable issue contract
4. small enough for one focused PR

Among those candidates, use the lowest `Queue Order` value as the deterministic tie-breaker. Items on `Platform` or `Migration` may have `Queue Order` values for board sorting, but they must never receive `Agent Dispatch = Yes`.

## Promoting the next Future issue after merge

When the currently dispatched issue is on `Future` and its PR merges:

1. Run post-merge handoff checks (`bash scripts/agent-handoff-check.sh`) from a local branch tracking `origin/master`.
2. Demote the merged issue: set `Agent Dispatch = No` and move `Status` to `Done` (or `Review` until human sign-off, per orchestrator judgment).
3. Scan open issues on dispatch-eligible tracks (`Product` or `Future`) with `Status = Ready`, using global `Queue Order` ascending as the tie-breaker.
4. Promote exactly one qualifying issue: set `Agent Dispatch = Yes` and confirm `Status = Ready`.
5. If no issue qualifies, leave the queue blocked and record the blocker on the project item or in an issue comment.

The same promotion procedure applies when the dispatched issue is on `Product`. The orchestrator does not need a separate Future-specific handoff path — only the track filter and issue contract differ.

## Project fields used together

| Field | Role in this policy |
|---|---|
| `Track` | Separates dispatch-eligible work (`Product`, `Future`) from non-dispatchable work (`Platform`, `Migration`) |
| `Agent Dispatch` | `Yes` only on the single dispatch-eligible issue a Codex worker may start; `No` everywhere else |
| `Status` | The dispatchable issue must be `Ready` |
| `Queue Order` | Global preferred execution order; dispatch promotion uses the lowest value among open `Ready` issues on `Product` or `Future` |
| `Execution Mode` | `Human` items are never dispatch candidates; `Agent`/`Either` dispatch-eligible items may eventually receive dispatch |

## What this policy does not change

- Codex orchestrator/worker procedure is documented in `codex-orchestration.md`.
- Branch prefixes and CI trigger conventions remain in `docs/operators/branch-and-ci-conventions.md`.
- `docs/planning/open-issue-order.json` remains a generated **product-track-only** compatibility artifact. It intentionally excludes `Future`, `Platform`, and `Migration` items. Do not treat it as dispatch authority — use live project fields instead.

## Automation alignment

`scripts/project-queue-check.sh` and `scripts/lib/project-queue-common.sh` validate that the single `Agent Dispatch = Yes` item is on a dispatch-eligible track (`Product` or `Future`). Platform and migration items must keep `Agent Dispatch = No`.

## Changing this policy

Update this file first, then reconcile `AGENTS.md`, the relevant `docs/operators/*.md` guides, and any issue templates in the same PR. Run `npm run check:branch-ci` if branch-prefix or workflow tables change.
