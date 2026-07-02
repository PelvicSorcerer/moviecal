# Documentation

This folder holds the product, design, technical, and planning documents for the moviecal project.

Recommended reading order for contributors and agents:
1. `.github/copilot-instructions.md`
2. `docs/product/product-brief.md`
3. `docs/product/requirements.md`
4. `docs/technical/architecture.md`
5. `docs/planning/implementation-plan.md`
6. `docs/planning/recommended-issue-sequence.md`
7. `docs/planning/agent-orchestration.md` (Codex orchestrator/worker operating procedure; see `AGENTS.md` if you are on a different agent platform, such as Cursor Cloud)
8. `docs/planning/agent-environment-compatibility-plan.md` (audit of agent/environment-specific artifacts; remaining work tracked as #98 and #102–#106)
9. `docs/planning/github-project-migration-plan.md` (migration + Platform track queue order for #92–#106)

Keep docs updated when behavior, routes, environment variables, or security assumptions change. Planning docs should describe the intended execution plan and issue hygiene; they should not be used as a historical progress tracker.

Fresh implementation sessions should use the GitHub issue queue as the source of truth for sequencing. When issue state and planning docs diverge, reconcile the GitHub issue first and then update the docs.
