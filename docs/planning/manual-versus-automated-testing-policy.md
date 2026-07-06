# Manual versus automated testing policy

This document defines what belongs in manual testing, what must be automated, and how issue-specific manual checklists relate to automated coverage. It complements [repository-testing-strategy.md](./repository-testing-strategy.md), which remains the authoritative guide for test layers, validation tiers, and capability-to-layer mapping.

For environment rules shared by manual and automated testing modes, especially disposable credential requirements and the exclusion of production or non-disposable shared state, see [test-environment-contract.md](./test-environment-contract.md).

Manual testing and automated testing work together. Automation provides fast, repeatable regression confidence on stable product surfaces. Manual testing covers exploratory work, release confidence, and gaps that automation cannot yet prove deterministically. Manual testing does not replace automation for behavior that can and should be verified in pull-request validation.

## Check classifications

Every verification step should fit one of three classes.

### Automated-required

Behavior in this class must be covered by automated tests in pull-request validation when the affected surface is deterministic enough to run in CI.

Examples:

- pure helpers such as date formatting, iCalendar escaping, stable UID generation, and environment parsing
- route handlers and server modules verified with mocked upstream dependencies
- auth gating, authorization branching, and protected-route behavior with stubbed or seeded sessions
- watchlist, search, and calendar flows once deterministic fixtures or route interception are available
- regression checks for stable product surfaces that have already been verified manually more than once

If automated coverage is not practical in the same pull request, the issue **Testing Expectations** and PR **Test Impact** sections must name a concrete follow-up issue before review handoff. Do not leave automated-required behavior on an open-ended manual checklist.

See [repository-testing-strategy.md](./repository-testing-strategy.md) for the capability-to-layer map and mock-versus-real integration rules.

### Temporary-manual

Behavior in this class may stay on a human local checklist only while automation is blocked or not yet landed.

Examples:

- a new user journey before browser fixtures, factories, or test-environment wiring exist
- real-stack database or migration behavior that belongs in Tier 2 validation rather than the default PR gate
- hosted-environment or post-deploy smoke checks that require a disposable full-stack environment
- one-off verification for infrastructure-sensitive wiring that mocks cannot prove yet

Temporary-manual checks are time-bounded. Each one needs either:

- a named follow-up issue that will move the check into automated-required coverage, or
- an explicit note in the manual checklist explaining why automation is still blocked and what prerequisite must land first.

Do not treat temporary-manual checks as permanent substitutes for automation on stable product surfaces.

### Manual-only

Behavior in this class is appropriately verified by humans and is not expected to move into everyday pull-request automation.

Examples:

- exploratory testing, usability review, and subjective UX judgment
- first-time local setup friction on a fresh machine or unfamiliar platform
- release-confidence spot checks on a hosted or staging environment before promotion
- calendar-client behavior in external apps such as iOS Calendar after subscribing to a feed
- visual polish, copy clarity, and layout judgment that automated assertions would make brittle

Manual-only checks may still inspire follow-up automation when a pattern becomes repeatable, but they do not create the same promotion obligation as temporary-manual or recurring regression checks.

## How manual checklists relate to automated coverage

Issue-specific manual checklists and automated tests answer different questions:

| Surface | Question it answers | Where it lives |
|---|---|---|
| **Testing Expectations** (issue) | What automated coverage should this change add or update? | Issue body |
| **Test Impact** (PR) | What automated coverage actually changed, or why not? | PR body |
| **Manual testing checklist** | What still needs human eyes on the pushed branch before review? | Worker handoff / orchestrator collection |

Use this split consistently:

- Put deterministic behavior in **Testing Expectations** and automate it in the same PR when practical.
- Put only temporary-manual and manual-only behavior in the issue-specific manual checklist.
- Do not duplicate automated-required checks in the manual checklist unless the issue explicitly calls for a release-confidence spot check on top of existing automation.
- When a manual checklist item verifies the same behavior as an automated test, prefer the automated test for everyday regression and drop the manual duplicate on the next pass.

The default checklist shape lives in [manual-testing-checklist-template.md](./manual-testing-checklist-template.md).

## Promoting recurring manual checks into automation

Repeated manual regression work is an automation candidate. Treat promotion as normal hygiene, not optional cleanup.

Promote a manual check when any of the following is true:

- the same regression step appears in manual checklists for two or more issues
- a human tester finds the same defect class twice after a related change
- a temporary-manual check has remained manual across more than one merged feature without a named blocker
- a stable product surface still depends on a human re-running the same happy path before every review

Promotion workflow:

1. Record the repeated check in the manual checklist **Notes for the orchestrator** section as an automation candidate.
2. Open or reference a concrete follow-up issue that states the behavior to automate and the target test layer from [repository-testing-strategy.md](./repository-testing-strategy.md).
3. Link that follow-up issue from the originating PR **Test Impact** section if the automation will not land in the same PR.
4. Remove the manual duplicate once automated coverage exists and is referenced in **Test Impact**.

Do not close a promotion loop by widening manual checklists indefinitely. The goal is to shrink temporary-manual scope over time while keeping manual-only judgment where humans add real value.

## Operating rules

- Run `npm run verify` (and any issue-specific automated commands) before asking for human local testing.
- Human local testing happens on the pushed issue branch before the PR is promoted from draft or work-in-progress to ready for review.
- Every implementation issue should include both **Testing Expectations** and an issue-specific manual testing checklist. See `AGENTS.md`, `.github/ISSUE_TEMPLATE/agent_task.md`, and `.github/pull_request_template.md`.
- Deferred automated coverage must reference a concrete follow-up issue number, not a vague backlog note.
- Keep all examples, fixtures, seeded data, and disposable credentials fake or dev-only. Do not use production secrets, private URLs, or real user data in manual or automated test guidance.

## Related docs

- [repository-testing-strategy.md](./repository-testing-strategy.md) — test layers, validation tiers, and capability mapping
- [manual-testing-checklist-template.md](./manual-testing-checklist-template.md) — default human local verification shape
- `AGENTS.md` — verification contract for all platforms
- `docs/operators/codex-orchestration.md` — human local testing loop for Codex orchestrator/worker handoff
