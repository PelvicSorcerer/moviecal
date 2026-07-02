# Multi-platform agent dispatch policy

This document is the single source of truth for which agent platforms may receive `Agent Dispatch = Yes` on a `moviecal Delivery` GitHub Project item after the project cutover (#92–#95).

Read `AGENTS.md` first for the generic queue contract. This policy answers the platform-specific question left open during the agent-environment compatibility refactor (Phase 5, issue **#102**).

## Queue authority (unchanged)

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues are authoritative for scoped execution contracts: background, acceptance criteria, verification steps, security notes, dependency notes, and out-of-scope boundaries.
- Exactly one open issue may have `Agent Dispatch = Yes` at any time, and that issue must also have `Status = Ready`. If no such issue exists, the queue is intentionally blocked.
- The `agent-ready` label is a derived compatibility surface only. After cutover, do not dispatch from labels alone — reconcile project fields first.

## Policy summary

| Project `Track` | Who may receive `Agent Dispatch = Yes` | Who may implement without the dispatch slot |
|---|---|---|
| **Product** (feature delivery) | **Codex workers only** | — (product work requires the dispatch slot) |
| **Platform** (compatibility, governance, process) | **Nobody** — always `Agent Dispatch = No` | Codex, Cursor Cloud Agent, GitHub Copilot, or humans via direct assignment |
| **Migration** (cutover work) | **Nobody** — always `Agent Dispatch = No` | Humans (or agents on explicit human assignment for doc-only migration items) |

### Product-track feature delivery

Only **Codex workers** may start implementation from the single `Agent Dispatch = Yes` / `Status = Ready` slot on product-track issues.

Rationale:

- This repo's feature-delivery operating model is a Codex orchestrator/worker contract: the orchestrator promotes issues, sets project dispatch fields, provisions worker worktrees, and validates checkpoint gates. See `docs/planning/agent-orchestration.md` and `docs/operators/codex.md`.
- The dispatch slot exists to give exactly one fresh Codex worker a deterministic start signal. Other platforms do not participate in that handshake.

Codex workers use `agent/<issue-number>-<short-slug>` branches. The Codex orchestrator uses `orchestrator/live` (or similar) and does not consume the dispatch slot for feature work.

### Platform-track and governance work

Platform-track issues (`Track = Platform`, including compatibility issues **#102–#106**) always keep `Agent Dispatch = No`. They are not eligible for the product dispatch slot regardless of platform.

Any agent platform or human may implement platform-track or governance work when **directly assigned** — for example:

- a Cursor Cloud Agent task such as "handle issue #102"
- a GitHub issue delegated to Copilot
- a human opening a `docs/**` or `chore/**` PR

Direct assignment is not the same as consuming `Agent Dispatch = Yes`. Agents on direct assignment must not set, assume, or compete for the product dispatch slot.

### Cursor Cloud Agent

- **May not** receive `Agent Dispatch = Yes` on any project item.
- **May** implement platform-track issues, governance/docs work, and other tasks when a human assigns them directly.
- Uses `cursor/<slug>-<run-id>` branches (platform-assigned). See `docs/operators/cursor-cloud.md`.

### GitHub Copilot coding agent

- **May not** receive `Agent Dispatch = Yes` on any project item.
- **May** implement work when GitHub assigns an issue or PR to Copilot, or when a human delegates a platform/governance task.
- Uses `copilot/**` branches (platform-assigned). See `docs/operators/github-copilot.md`.

### Governance branch prefixes

Governance and queue-maintenance changes that are not tied to a product implementation issue use `docs/**` or `chore/**` branches. These branches are available to any agent platform or human and do not require `Agent Dispatch = Yes`. See `docs/operators/branch-and-ci-conventions.md`.

## Project fields used together

| Field | Role in this policy |
|---|---|
| `Track` | Separates product delivery (`Product`) from platform/governance work (`Platform`, `Migration`) |
| `Agent Dispatch` | `Yes` only on the single product-track issue a Codex worker may start; `No` everywhere else |
| `Status` | The dispatchable issue must be `Ready` |
| `Queue Order` | Tie-breaker when multiple product issues could plausibly be promoted |
| `Execution Mode` | `Human` items are never dispatch candidates; `Agent`/`Either` product items may eventually receive dispatch |

## What this policy does not change

- Codex orchestrator/worker procedure remains in `docs/planning/agent-orchestration.md` until consolidated by issue **#104**.
- Project automation and `scripts/project-queue-check.sh` validation rules are unchanged (issue **#94** scope if further automation is needed).
- Branch prefixes and CI trigger conventions remain in `docs/operators/branch-and-ci-conventions.md`.

## Changing this policy

Update this file first, then reconcile `AGENTS.md`, the relevant `docs/operators/*.md` guides, and any issue templates in the same PR. Run `npm run check:branch-ci` if branch-prefix or workflow tables change.
