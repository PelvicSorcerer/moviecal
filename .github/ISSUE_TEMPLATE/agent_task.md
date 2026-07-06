Agent task template

Use this template when creating tasks for any coding agent (Codex, Cursor, GitHub Copilot, or similar).

- Title: short task title
- Background: context and why this change is needed
- Goal: one clear outcome for a single PR
- Relevant docs: exact repo docs the worker must read first
- Dependencies / blocked by: upstream issues, infra, or tooling prerequisites
- Goal / Acceptance criteria: explicit, testable criteria (pass/fail)
- Files to change: list of file paths to inspect or modify

## Testing Expectations

State the expected automated coverage up front. Use `docs/planning/repository-testing-strategy.md` to pick the right test layers for the capability being changed.

- Unit tests: <!-- which helpers, parsers, or pure logic -->
- Integration tests: <!-- which routes, modules, or mocked boundaries -->
- Browser E2E: <!-- which user journeys, or "none in this issue" -->
- Verification commands: <!-- e.g. npm run verify, npm run lane:browser -->
- Deferred coverage follow-up: <!-- if any layer above is deferred, name the concrete follow-up issue number (for example #NNN) that must exist before merge; do not defer to a vague umbrella testing issue -->

- Manual testing checklist: issue-specific local verification steps for the human tester, including setup assumptions, happy path, edge cases, regression checks, and expected results
- Security notes: required for auth, database, calendar, cron, tokens, or secrets work
- Out of scope: prevent adjacent backlog creep
- Constraints: (e.g., no secrets, TypeScript strict, keep changes small)
- Branch to start from: (e.g., master)
- Queue note: whether this issue is eligible for `Status = Ready`, whether it could ever receive `Agent Dispatch = Yes` (only on dispatch-eligible tracks `Product` or `Future`, Codex workers only), and where it should sit in the GitHub Project `Queue Order`
- Manual verification steps / notes for reviewer
