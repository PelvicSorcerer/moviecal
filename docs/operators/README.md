# Operator docs

Read `AGENTS.md` first.

This folder holds platform-specific operator guidance that sits underneath the repo-wide workflow contract.

Queue authority:

- The `moviecal Delivery` GitHub Project is authoritative for live queue state, workflow status, queue ordering, and dispatch selection.
- GitHub issues are authoritative for scoped execution contracts: background, acceptance criteria, verification steps, security notes, dependency notes, and out-of-scope boundaries.
- `agent-ready` is a compatibility label only. If it is still present, it is derived from the project `Agent Dispatch` field and must not override project state.

Platform guides:

- `docs/operators/codex.md`: Codex-specific operator notes, including worktree/bootstrap expectations and how the project-first queue model fits the Codex orchestrator/worker workflow.

If another operator guide is added later, keep `AGENTS.md`, this index, and the relevant CI/branch-prefix references in sync in the same PR.
