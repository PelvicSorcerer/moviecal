Agent task template

Use this template when creating tasks for any coding agent (Codex, Cursor, GitHub Copilot, or similar).

- Title: short task title
- Background: context and why this change is needed
- Goal: one clear outcome for a single PR
- Relevant docs: exact repo docs the worker must read first
- Dependencies / blocked by: upstream issues, infra, or tooling prerequisites
- Goal / Acceptance criteria: explicit, testable criteria (pass/fail)
- Files to change: list of file paths to inspect or modify
- Automated test coverage plan: specify the expected unit, integration, and Playwright coverage for this issue
- Tests to run: unit/integration/e2e commands and expected outcomes
- Deferred coverage follow-up: if Playwright coverage is not feasible in this issue, name the immediate feature-specific follow-up issue that must be created before merge; do not defer it to a broad umbrella testing issue
- Manual testing checklist: issue-specific local verification steps for the human tester, including setup assumptions, happy path, edge cases, regression checks, and expected results
- Security notes: required for auth, database, calendar, cron, tokens, or secrets work
- Out of scope: prevent adjacent backlog creep
- Constraints: (e.g., no secrets, TypeScript strict, keep changes small)
- Branch to start from: (e.g., master)
- Queue note: whether this issue is eligible for `Status = Ready`, whether it could ever receive `Agent Dispatch = Yes`, and where it should sit in the GitHub Project `Queue Order`
- Manual verification steps / notes for reviewer
