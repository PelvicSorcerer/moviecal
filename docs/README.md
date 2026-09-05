# Documentation

This folder holds the product, design, technical, and planning documents for the moviecal project.

Recommended reading order for contributors and agents:

1. `AGENTS.md` (repo root) — generic agent contract; routes to `docs/operators/local-execution.md` and `worker-routing.md`
2. `.github/copilot-instructions.md`
3. `docs/governance/linear-information-architecture.md` — the Linear workspace design and source-of-truth boundaries
4. `docs/operators/local-execution.md` — the local-Mac dispatcher: worktree lifecycle, worker interface, security model
5. `docs/product/product-brief.md`
6. `docs/product/requirements.md`
7. `docs/technical/architecture.md`
8. `docs/planning/implementation-plan.md`
9. `docs/planning/recommended-issue-sequence.md`

Keep docs updated when behavior, routes, environment variables, or security assumptions change. Planning docs should describe the intended execution plan and issue hygiene; they should not be used as a historical progress tracker.

Linear is the source of truth for sequencing, workflow state, and agent delegation. GitHub remains the source of truth for source control, PRs, CI, and releases. See `docs/governance/linear-information-architecture.md` for the full boundary. When Linear and docs diverge, reconcile Linear first and then update the docs.

Historical, GitHub-Project-centric planning docs (the previous control plane, superseded by Linear) are preserved for reference in `docs/planning/archive/` and `docs/operators/archive/` — see `docs/planning/decision-log.md` for the full migration record.
