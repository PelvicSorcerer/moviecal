# Operator guides index

Read `AGENTS.md` first.

This directory holds this repo's local-Mac execution documentation. `AGENTS.md` at the repo root is the required starting point for every agent or human contributor; it routes here for the local-execution and worker-routing detail so it can stay short enough to read in full every session.

## Current files

- `local-execution.md` — the dispatcher architecture: preflight gates, worktree lifecycle, worker interface, and the security model (what's GitHub-enforced, what's Claude-Code-harness-enforced, and what's still a written policy — see MOV-116).
- `worker-routing.md` — how a worker binary (Claude Code or Codex) and model tier are selected per Linear issue.
- `branch-and-ci-conventions.md` — single source of truth for branch-prefix mapping and which CI workflows must reference each prefix.
- `branch-prefixes.json` — machine-readable version of the same table, read by `scripts/check-branch-ci-conventions.py`.

## Historical

This directory previously held one guide per agent platform (Codex, Cursor Cloud, GitHub Copilot, Claude Code) under a GitHub-Project-centric, multi-cloud-agent dispatch model. That model is retired in favor of Linear as the control plane and this Mac as the sole execution environment — see `docs/governance/linear-information-architecture.md` and `docs/planning/decision-log.md` for the full migration record. The superseded guides are preserved for historical reference in `docs/operators/archive/`; do not follow them for current work.
