Agent task template

New agent-delegated work is created as a Linear issue, not a GitHub issue — see `docs/governance/linear-information-architecture.md`. Use this checklist as the field list for a Linear issue destined for `Ready for Agent`. It is kept here (rather than only in Linear) because it is app-level policy that must survive independently of any particular work-item tool.

This file remains useful for: shaping an issue before it exists in Linear, external contributors proposing agent-shaped work via GitHub (which then gets moved into Linear during triage), and as a reference for what "acceptance criteria are current" means during preflight (`AGENTS.md`).

- Title: short task title
- Background: context and why this change is needed
- Goal: one clear outcome for a single PR
- Relevant docs: exact repo docs the worker must read first
- Dependencies / blocked by: upstream issues, infra, or tooling prerequisites — represent these as native Linear `blocked by` relations, not free text
- Acceptance criteria: explicit, testable criteria (pass/fail)
- Files to change: list of file paths to inspect or modify

## Testing Expectations

State the expected automated coverage up front. Use `docs/planning/repository-testing-strategy.md` to pick the right test layers for the capability being changed.

- Unit tests: <!-- which helpers, parsers, or pure logic -->
- Integration tests: <!-- which routes, modules, or mocked boundaries -->
- Browser E2E: <!-- which user journeys, or "none in this issue" -->
- Verification commands: <!-- e.g. npm run verify, npm run lane:browser -->
- Deferred coverage follow-up: <!-- if any layer above is deferred, name the concrete follow-up Linear issue that must exist before merge; do not defer to a vague umbrella testing issue -->

- Manual testing checklist: issue-specific local verification steps for the human tester, including setup assumptions, happy path, edge cases, regression checks, and expected results
- Security notes: required for auth, database, calendar, cron, tokens, or secrets work
- Out of scope: prevent adjacent backlog creep
- Constraints: (e.g., no secrets, TypeScript strict, keep changes small)
- Branch to start from: (e.g., master)
- Worker / model routing: `worker:*` / `model:*` labels if a specific worker or model tier is required, with the upgrade condition cited — see `docs/operators/worker-routing.md`
- Manual verification steps / notes for reviewer
