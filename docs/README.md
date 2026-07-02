# Documentation

This folder holds the product, design, technical, and planning documents for the moviecal project.

Recommended reading order for contributors and agents:

1. `AGENTS.md` (repo root) — generic agent contract; routes you to `docs/operators/*.md` for your specific platform
2. `.github/copilot-instructions.md`
3. `docs/operators/README.md` — platform operator index and queue-authority summary
4. `docs/operators/multi-platform-dispatch-policy.md` — which platforms may receive `Agent Dispatch = Yes`
5. `docs/operators/codex-orchestration.md` — Codex orchestrator/worker operating procedure (Codex only)
6. `docs/product/product-brief.md`
7. `docs/product/requirements.md`
8. `docs/technical/architecture.md`
9. `docs/planning/implementation-plan.md`
10. `docs/planning/recommended-issue-sequence.md`
11. `docs/planning/agent-environment-compatibility-plan.md` (audit of agent/environment-specific artifacts; remaining work tracked as issues #105–#106)
12. `docs/planning/github-project-migration-plan.md` (migration + Platform track queue order for #92–#106)

Keep docs updated when behavior, routes, environment variables, or security assumptions change. Planning docs should describe the intended execution plan and issue hygiene; they should not be used as a historical progress tracker.

Fresh implementation sessions should use the `moviecal Delivery` GitHub Project as the source of truth for sequencing, workflow state, and dispatch. GitHub issues remain the source of truth for the scoped execution contract. When project state and docs diverge, reconcile the project first and then update the docs.
