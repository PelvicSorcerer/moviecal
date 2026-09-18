# Manual versus automated testing policy

This document defines what belongs in manual testing, what must be automated, and how issue-specific manual checklists relate to automated coverage. It complements [repository-testing-strategy.md](./repository-testing-strategy.md), which remains the authoritative guide for test layers, validation tiers, and capability-to-layer mapping.

For environment rules shared by manual and automated testing modes, especially disposable credential requirements and the exclusion of production or non-disposable shared state, see [test-environment-contract.md](./test-environment-contract.md).

Manual testing and automated testing work together. Automation provides fast, repeatable regression confidence on stable product surfaces. Manual testing covers exploratory work, release confidence, and gaps that automation cannot yet prove deterministically. Manual testing does not replace automation for behavior that can and should be verified in pull-request validation.

## Verification classifications

Every verification step must fit one of four classes. The classification says
both who can supply the evidence and whether that evidence can be repeated in
pull-request validation.

### Automated (required)

Behavior in this class must be covered by automated tests in pull-request validation when the affected surface is deterministic enough to run in CI.

Examples:

- pure helpers such as date formatting, iCalendar escaping, stable UID generation, and environment parsing
- route handlers and server modules verified with mocked upstream dependencies
- auth gating, authorization branching, and protected-route behavior with stubbed or seeded sessions
- watchlist, search, and calendar flows once deterministic fixtures or route interception are available
- regression checks for stable product surfaces that have already been verified manually more than once

If automated coverage is not practical in the same pull request, the issue **Testing Expectations** and PR **Test Impact** sections must name a concrete follow-up issue before review handoff. Do not leave automated-required behavior on an open-ended manual checklist.

See [repository-testing-strategy.md](./repository-testing-strategy.md) for the capability-to-layer map and mock-versus-real integration rules.

### Local-agent evidence

Behavior in this class is verified by a local agent in the provisioned issue
worktree, but is not part of a deterministic CI lane. Evidence must be
reproducible and attached to the handoff or PR: the exact command or procedure,
environment assumptions, result, and any artifact path or link.

Examples:

- a macOS-only integration check that cannot run on GitHub-hosted Linux
- a disposable local-stack or simulator command whose setup is not a required CI lane
- a one-time migration, packaging, or operator exercise with captured output

Local-agent evidence is not human testing. It cannot satisfy a human gate for
subjective judgment, assistive-technology use, a physical device, or a
security-sensitive user flow. Stable repeatable evidence should move into
automated-required coverage rather than remain in this class indefinitely.

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

### Permanently manual-only

Behavior in this class is appropriately verified by humans and is not expected to move into everyday pull-request automation.

Examples:

- exploratory testing, usability review, and subjective UX judgment
- first-time local setup friction on a fresh machine or unfamiliar platform
- release-confidence spot checks on a hosted or staging environment before promotion
- calendar-client behavior in external apps such as iOS Calendar after subscribing to a feed
- visual polish, copy clarity, and layout judgment that automated assertions would make brittle

Permanently manual-only checks may still inspire follow-up automation when a pattern becomes repeatable, but they do not create the same promotion obligation as temporary-manual or recurring regression checks.

## Declaring whether human testing is required

Every local implementation issue must contain a `## Manual Verification`
section with exactly one structured marker:

- `Human testing: required`
- `Human testing: not-required`

Absence of the section or marker is an incomplete issue, never an implicit
waiver. `not-required` is allowed only when all acceptance criteria are covered
by automated-required checks and/or reproducible local-agent evidence and none
of the mandatory human gates below applies. The issue must explain the
rationale. `required` must include an issue-specific checklist whose items are
classified as temporary-manual or permanently manual-only.

Human testing is always required for:

- iOS simulator interaction, physical-device behavior, external iOS app
  integration, and platform permission flows (an `xcodebuild` result alone is
  local-agent or automated evidence, not interactive evidence)
- visual polish, responsive layout judgment, animation, and screenshot review
- accessibility behavior that depends on VoiceOver, keyboard/focus traversal,
  Dynamic Type, contrast judgment, or another assistive technology
- auth, authorization, private-data, token, calendar-feed, destructive-data,
  payment, or production/deployment flows where a failure could expose data or
  materially affect a user

Low-risk documentation, internal refactors, pure helpers, and deterministic
server changes may use `Human testing: not-required` when their automated and
local-agent evidence covers every acceptance criterion. Risk labels do not
waive the gates above.

Representative decisions:

| Change surface | Default declaration | Required evidence |
|---|---|---|
| Web copy or layout visible to users | `required` | CI plus human visual/accessibility checklist as applicable |
| Deterministic server helper or route with no sensitive boundary | `not-required` | Unit/integration coverage for every acceptance criterion |
| Auth, authorization, private database/RLS, or calendar-token flow | `required` | Automated security boundary coverage plus a disposable-account human checklist |
| Database migration with no user-visible or sensitive behavior | Case by case | Real-stack automation or reproducible local-agent evidence; human testing if destructive or privacy-sensitive |
| iOS build-only configuration | Case by case | `xcodebuild` evidence may support `not-required` only when no simulator/device interaction or platform permission behavior changes |
| iOS UI, simulator/device, external Calendar, or permission behavior | `required` | iOS lane evidence plus a human simulator/device checklist |

## Draft-to-ready decision

The local dispatcher always opens a draft PR. Ordinarily, only an authorized
human reviewer may promote it to ready for review. The sole exception is the
MOV-162 fail-closed autonomy policy: an explicitly marked, `risk:low`,
`agent-ready`, `execution:mac` docs-only PR with `Human testing:
not-required`, complete evidence, and current passing checks may be promoted
automatically. All other PRs remain human-controlled.

Before promotion, the reviewer confirms the PR's `## Readiness Evidence`
section records:

- the same `Human testing` marker as the issue
- passing required CI and the exact local-agent evidence, if any
- for `required`, the human tester and dated checklist result, including any
  failed or deferred item
- for `not-required`, the reviewer-approved rationale that every acceptance
  criterion is covered and no mandatory human gate applies
- `Ready promoted by`, naming the human reviewer and date

For the MOV-162 exception, `Autonomy: eligible` replaces the human promotion
line only for the qualifying draft-to-ready action. Auto-merge remains
conservative: the ready PR must retain passing current-SHA required checks
(including the independent `lane-review` control) and have no requested
changes before the dispatcher asks GitHub to enable normal auto-merge.
GitHub's ruleset and required checks remain authoritative; the dispatcher
never bypasses them.

A failed checklist keeps the PR in draft until fixed and re-tested. A deferred
required item keeps it in draft unless the issue scope and acceptance criteria
are explicitly changed by a human. Green CI alone never promotes a draft.

## How manual checklists relate to automated coverage

Issue-specific manual checklists and automated tests answer different questions:

| Surface | Question it answers | Where it lives |
|---|---|---|
| **Testing Expectations** (issue) | What automated coverage should this change add or update? | Issue body |
| **Test Impact** (PR) | What automated coverage actually changed, or why not? | PR body |
| **Manual Verification** (issue) | Is human execution required, and why? | Issue body |
| **Readiness Evidence** (PR) | Who supplied the required automated, agent, and human evidence and who approved readiness? | PR body |

Use this split consistently:

- Put deterministic behavior in **Testing Expectations** and automate it in the same PR when practical.
- Put reproducible non-CI worktree results in local-agent evidence.
- Put only temporary-manual and permanently manual-only behavior in a required issue-specific manual checklist.
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

Do not close a promotion loop by widening manual checklists indefinitely. The goal is to shrink temporary-manual scope over time while keeping permanently manual-only judgment where humans add real value.

## Operating rules

- Run `npm run verify` (and any issue-specific automated commands) before asking for human local testing.
- When required, human local testing happens on the pushed issue branch before the PR is promoted from draft or work-in-progress to ready for review.
- Every local implementation issue must include both **Testing Expectations** and **Manual Verification**. A checklist is mandatory when `Human testing: required`; a rationale is mandatory when `Human testing: not-required`.
- Deferred automated coverage must reference a concrete follow-up issue number, not a vague backlog note.
- Keep all examples, fixtures, seeded data, and disposable credentials fake or dev-only. Do not use production secrets, private URLs, or real user data in manual or automated test guidance.

## Related docs

- [repository-testing-strategy.md](./repository-testing-strategy.md) — test layers, validation tiers, and capability mapping
- [manual-testing-checklist-template.md](./manual-testing-checklist-template.md) — default human local verification shape
- `AGENTS.md` — verification contract for all platforms
- `docs/operators/codex-orchestration.md` — human local testing loop for Codex orchestrator/worker handoff
