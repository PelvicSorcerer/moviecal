# Multi-platform agent dispatch policy

This document is the single source of truth for which agent platforms may receive `Agent Dispatch = Yes` on a `moviecal Delivery` GitHub Project item after the project cutover (#92–#95).

Read `AGENTS.md` first for the generic queue contract. This policy answers the platform-specific question left open during the agent-environment compatibility refactor (Phase 5, issue **#102**) and reconciles live project usage of `Track = Future` (issue **#147**).

## Queue authority (unchanged)

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues are authoritative for scoped execution contracts: background, acceptance criteria, verification steps, security notes, dependency notes, and out-of-scope boundaries.
- Exactly one open issue may have `Agent Dispatch = Yes` at any time, and that issue must also have `Status = Ready`. If no such issue exists, the queue is intentionally blocked.
- The `agent-ready` label is a derived compatibility surface only. After cutover, do not dispatch from labels alone — reconcile project fields first.

## Orchestrator role

**Any platform may act as orchestrator.** The orchestrator role — reading queue state, promoting issues, setting `Agent Dispatch = Yes`, and running post-merge handoff — is not restricted to Codex. Claude Code, Cursor Cloud Agent, and GitHub Copilot may each run a full governance cycle using their own native tools.

What differs per platform is the *mechanics*: Codex uses `spawn_agent` with provisioned worktrees and a formal two-step checkpoint gate; Claude Code uses the `Agent` tool with GitHub MCP server calls; Cursor uses `gh` CLI with a PAT; Copilot uses `gh` CLI via PAT or the `/project-update` comment command. The lifecycle steps are equivalent across all platforms:

1. Read current queue state (identify the merged issue and confirm it is closed).
2. Demote the merged issue (`Agent Dispatch = No`, `Status = Done`).
3. Select the next ready issue by `Queue Order` on dispatch-eligible tracks.
4. Promote exactly one issue (`Agent Dispatch = Yes`, `Status = Ready`), or record a blocker.
5. Optionally dispatch or assign a worker for the promoted issue.

See each platform's operator guide for the platform-specific orchestrator procedure:
- Claude Code: `docs/operators/claude-code.md` — Orchestrator role section
- Cursor: `docs/operators/cursor-cloud.md` — Orchestrator role section
- Copilot: `docs/operators/github-copilot.md` — Orchestrator role section
- Codex: `docs/operators/codex-orchestration.md` (the original, unchanged reference)

## Dispatch-eligible tracks

Two project tracks may hold the single dispatch slot when intentionally promoted:

| Track | Meaning | Dispatch eligible |
|---|---|---|
| **Product** | User-facing feature delivery | **Yes** — see dispatch-slot section below |
| **Future** | Executable non-product workstreams (testing programs, architecture hardening, strategic infrastructure) | **Yes** — see dispatch-slot section below |
| **Platform** | Compatibility, governance, process | **No** — always `Agent Dispatch = No` |
| **Migration** | Cutover work | **No** — always `Agent Dispatch = No` |

`Future` is not a parking lot for vague ideas. A `Future`-track issue must still have a normal executable issue contract (acceptance criteria, verification steps, **Testing Expectations**, relevant docs) before it can be promoted to `Status = Ready` and receive dispatch.

## Policy summary

| Project `Track` | Who may set `Agent Dispatch = Yes` (as orchestrator) | Who may start from `Agent Dispatch = Yes` (as worker) | Who may implement via direct assignment |
|---|---|---|---|
| **Product** (feature delivery) | Any platform or human acting as orchestrator | **Codex workers only** (formal spawn_agent handshake) | Any platform or human (when directly assigned, without the dispatch slot) |
| **Future** (non-product executable workstreams) | Any platform or human acting as orchestrator | **Codex workers only** (formal spawn_agent handshake) | Any platform or human (when directly assigned, without the dispatch slot) |
| **Platform** (compatibility, governance, process) | Not applicable — always `Agent Dispatch = No` | Not applicable | Any platform or human via direct assignment |
| **Migration** (cutover work) | Not applicable — always `Agent Dispatch = No` | Not applicable | Humans (or agents on explicit human assignment for doc-only migration items) |

### Dispatch-slot work (Product and Future tracks)

Only **Codex workers** may start implementation from the single `Agent Dispatch = Yes` / `Status = Ready` slot, regardless of whether the promoted issue is on `Product` or `Future`. This restriction applies to the *worker* role only — any orchestrating platform may set the dispatch slot.

Rationale:

- The formal Codex dispatch slot is a Codex orchestrator/worker handshake: the orchestrator provisions worker worktrees and validates checkpoint gates (see `codex-orchestration.md` and `codex.md`). Non-Codex platforms lack the `spawn_agent` mechanism needed for that handshake.
- The dispatch slot exists to give exactly one fresh Codex worker a deterministic start signal. Non-Codex platforms implement work via direct assignment instead.

Codex workers use `agent/<issue-number>-<short-slug>` branches. The Codex orchestrator uses `orchestrator/live` (or similar) and does not consume the dispatch slot for feature work.

### Direct assignment path (Product and Future tracks)

Any agent platform (Claude Code, Cursor Cloud Agent, GitHub Copilot) or human may implement a **Product** or **Future** track issue when **directly assigned**, without requiring or competing for the dispatch slot. Direct assignment means:

- A human (engineer, lead, or orchestrator session) explicitly assigns the issue to a specific agent or delegates the issue to them.
- The issue remains at `Agent Dispatch = No` — it does not consume the single dispatch slot.
- The implementing agent uses its platform-assigned branch prefix (e.g., `claude/**` for Claude Code, `cursor/**` for Cursor, `copilot/**` for Copilot).

**This is distinct from dispatch-slot work:** the slot is a Codex-only formal handshake where an orchestrator promotes exactly one issue and provisions a worker. Direct assignment is a lightweight alternative available to every platform on every track.

Direct assignment does not affect the queue invariant that exactly one open issue may have `Agent Dispatch = Yes` at any time.

### Platform-track and governance work

Platform-track issues (`Track = Platform`, including compatibility issues **#102–#106**) always keep `Agent Dispatch = No`. They are not eligible for the dispatch slot regardless of platform.

Any agent platform or human may implement platform-track or governance work when **directly assigned** — for example:

- a Cursor Cloud Agent task such as "handle issue #102"
- a GitHub issue delegated to Copilot
- a human opening a `docs/**` or `chore/**` PR

Direct assignment is not the same as consuming `Agent Dispatch = Yes`. Agents on direct assignment must not set, assume, or compete for the dispatch slot.

### Cursor Cloud Agent

- **May not** start from `Agent Dispatch = Yes` on any project item (as worker).
- **May** act as orchestrator: promote issues, set `Agent Dispatch = Yes`, run post-merge handoff. See the orchestrator section in `docs/operators/cursor-cloud.md`.
- **May** implement Product, Future, Platform, or other work when a human assigns them directly (see "Direct assignment path" above).
- Uses `cursor/<slug>-<run-id>` branches (platform-assigned). See `docs/operators/cursor-cloud.md`.

### GitHub Copilot coding agent

- **May not** start from `Agent Dispatch = Yes` on any project item (as worker).
- **May** act as orchestrator: promote issues, set `Agent Dispatch = Yes`, run post-merge handoff. See the orchestrator section in `docs/operators/github-copilot.md`.
- **May** implement Product, Future, Platform, or other work when a human assigns them directly, or when GitHub assigns an issue or PR to Copilot (see "Direct assignment path" above).
- Uses `copilot/**` branches (platform-assigned). See `docs/operators/github-copilot.md`.

### Claude Code

- **May not** start from `Agent Dispatch = Yes` on any project item (as worker) via the formal Codex dispatch handshake.
- **May** act as orchestrator: promote issues, set `Agent Dispatch = Yes`, run post-merge handoff. See the orchestrator section in `docs/operators/claude-code.md`.
- **May** implement any track when a human assigns the issue or delegates it directly.
- Uses `claude/**` branches. See `docs/operators/claude-code.md`.

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

## Post-merge handoff (any orchestrating platform)

The following steps apply regardless of which platform ran the orchestrator session:

1. Pull or confirm an attached local branch tracking `origin/master` contains the merged work.
2. Confirm the completed issue is closed and no duplicate or stale PR remains open for the same work.
3. Demote the merged issue: post `/project-update Status=Done AgentDispatch=No` on the issue, or use the platform's equivalent GitHub API call.
4. Scan open issues on dispatch-eligible tracks (`Product` or `Future`) with `Status = Ready`, ordered by `Queue Order` ascending.
5. Promote exactly one qualifying issue: post `/project-update Status=Ready AgentDispatch=Yes` on that issue. If no issue qualifies, record the blocker instead.
6. Update planning or guidance docs only if the merge changed queue assumptions.
7. Optionally dispatch or assign a worker for the promoted issue using the platform's native mechanism.

For Codex-specific post-merge detail (worktree cleanup, `wait_agent` collection) see `codex-orchestration.md` — that contract is unchanged.

## Project fields used together

| Field | Role in this policy |
|---|---|
| `Track` | Separates dispatch-eligible work (`Product`, `Future`) from non-dispatchable work (`Platform`, `Migration`) |
| `Agent Dispatch` | `Yes` only on the single dispatch-eligible issue; any orchestrating platform may set this field |
| `Status` | The dispatchable issue must be `Ready` |
| `Queue Order` | Global preferred execution order; dispatch promotion uses the lowest value among open `Ready` issues on `Product` or `Future` |
| `Execution Mode` | `Human` items are never dispatch candidates; `Agent`/`Either` dispatch-eligible items may eventually receive dispatch |

## What this policy does not change

- Codex orchestrator/worker procedure is documented in `codex-orchestration.md` and is preserved unchanged. Non-Codex platforms add parallel governance paths alongside it.
- Branch prefixes and CI trigger conventions remain in `docs/operators/branch-and-ci-conventions.md`.
- `docs/planning/open-issue-order.json` remains a generated **product-track-only** compatibility artifact. It intentionally excludes `Future`, `Platform`, and `Migration` items. Do not treat it as dispatch authority — use live project fields instead.

## Automation alignment

`scripts/project-queue-check.sh` and `scripts/lib/project-queue-common.sh` validate that the single `Agent Dispatch = Yes` item is on a dispatch-eligible track (`Product` or `Future`). Platform and migration items must keep `Agent Dispatch = No`.

## Changing this policy

Update this file first, then reconcile `AGENTS.md`, the relevant `docs/operators/*.md` guides, and any issue templates in the same PR. Run `npm run check:branch-ci` if branch-prefix or workflow tables change.
