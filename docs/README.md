# Documentation

This folder holds the product, design, technical, and planning documents for the moviecal project.

Recommended reading order for contributors and agents:
1. `.github/copilot-instructions.md`
2. `AGENTS.md`
3. `docs/operators/README.md`
4. `docs/product/product-brief.md`
5. `docs/product/requirements.md`
6. `docs/technical/architecture.md`
7. `docs/planning/implementation-plan.md`
8. `docs/planning/recommended-issue-sequence.md`
9. `docs/planning/agent-orchestration.md`
10. `docs/planning/agent-environment-compatibility-plan.md`

Keep docs updated when behavior, routes, environment variables, or security assumptions change. Planning docs should describe the intended execution plan and issue hygiene; they should not be used as a historical progress tracker.

Fresh implementation sessions should use the `moviecal Delivery` GitHub Project as the source of truth for sequencing, workflow state, and dispatch. GitHub issues remain the source of truth for the scoped execution contract. When project state and docs diverge, reconcile the project first and then update the docs.
