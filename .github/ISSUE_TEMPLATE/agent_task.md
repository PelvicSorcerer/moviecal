Agent task template

Use this template when creating tasks for Copilot agents.

- Title: short task title
- Background: context and why this change is needed
- Goal: one clear outcome for a single PR
- Relevant docs: exact repo docs the worker must read first
- Dependencies / blocked by: upstream issues, infra, or tooling prerequisites
- Goal / Acceptance criteria: explicit, testable criteria (pass/fail)
- Files to change: list of file paths to inspect or modify
- Tests to run: unit/integration/e2e commands and expected outcomes
- Security notes: required for auth, database, calendar, cron, tokens, or secrets work
- Out of scope: prevent adjacent backlog creep
- Constraints: (e.g., no secrets, TypeScript strict, keep changes small)
- Branch to start from: (e.g., master)
- Queue note: whether this issue is eligible for `agent-ready` now and, if it belongs in the current queue, where it should appear in `docs/planning/open-issue-order.json`
- Manual verification steps / notes for reviewer
