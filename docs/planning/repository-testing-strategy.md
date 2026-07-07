# Repository testing strategy

This document is the single authoritative testing strategy for the repository. Use it when deciding what automated coverage a feature needs, which test layer should own that coverage, and which checks belong in pull-request validation versus heavier runtime validation.

For environment assumptions by testing mode, including which credentials, seeded data, and resources are allowed in deterministic, real-stack, and smoke validation, see [test-environment-contract.md](./test-environment-contract.md).

For what belongs in manual testing versus automation, how recurring manual regressions are promoted into automated work, and how issue-specific manual checklists relate to automated coverage, see [manual-versus-automated-testing-policy.md](./manual-versus-automated-testing-policy.md).

For explicit lane commands, CI job names, and what each lane is expected to catch, see [testing-lanes.md](./testing-lanes.md).

For browser/runtime startup conventions, failure artifacts, retry policy, and quarantine rules, see [browser-runtime-test-stability.md](./browser-runtime-test-stability.md).

## Goals

- Keep pull-request validation fast, deterministic, and safe to run without production secrets.
- Add coverage alongside feature delivery instead of deferring behavior verification to a broad later sweep.
- Use mocks where they preserve determinism and trust the contract under test.
- Require real integrations only where a mock would hide the behavior we actually need to prove.

## Validation tiers

### Tier 1: fast deterministic pull-request validation

This is the default gate for everyday feature work.

- Run `npm run verify` on pull requests (baseline, unit, and integration lanes — see [testing-lanes.md](./testing-lanes.md)).
- Run `npm run lane:browser` for full-stack browser coverage (separate CI workflow).
- Prefer unit tests, deterministic integration tests, and any browser tests that can run from stable fixtures, seeded test data, or route interception.
- Do not require production secrets, real third-party traffic, or long-lived shared environments.
- Failures in this tier should usually mean a real regression, not flaky infrastructure.

### Tier 2: heavier real-stack or runtime validation

Use this tier when the behavior depends on infrastructure that mocks cannot prove correctly.

- Real database schema validation belongs here, using `npm run lane:real-stack` against a disposable database when available or the authoritative `supabase-verify` GitHub Actions workflow (`lane-real-stack` job).
- External smoke checks, hosted-environment checks, and post-deploy verification belong here (`lane:smoke-external` and `lane:smoke-post-deploy`; see [testing-lanes.md](./testing-lanes.md)).
- These checks may run less often than the default PR gate, but they remain required before trusting infrastructure-sensitive changes.

## Capability-to-layer map

| Capability | Primary test layers | Notes |
|---|---|---|
| Pure utilities such as date formatting, iCalendar escaping, stable UID generation, and environment parsing | Unit | Keep inputs explicit and deterministic. |
| TMDb normalization and provider error handling | Unit, deterministic integration | Mock TMDb HTTP responses; do not hit the live API in PR validation. |
| Supabase helper configuration and server-side data-access branching | Unit, deterministic integration | Mock Supabase clients or responses when verifying application behavior. |
| Auth gating, page protection, and request authorization flow | Deterministic integration, browser E2E | Use seeded or stubbed sessions for PR validation. |
| Search, watchlist mutations, and protected UI flows | Browser E2E, deterministic integration | Prefer Playwright fixtures plus route interception over live third-party services. |
| Calendar token rotation, private feed authorization, and feed rendering | Unit, deterministic integration, browser E2E where user-facing | Keep token examples disposable; invalid-token handling should stay deterministic. |
| Supabase schema, migrations, and database-specific constraints | Real-stack validation | Use disposable databases or the `supabase-verify` workflow rather than mocks alone. |
| Cron-triggered refresh flows and deployment wiring | Deterministic integration plus external smoke/post-deploy checks | Mock scheduler calls in PRs; verify deployed wiring separately. |

## Mocking policy

Mocks are acceptable when they help us verify repository-owned logic without introducing flaky dependencies.

Accept mocks for:

- third-party HTTP responses such as TMDb search and detail payloads
- authenticated sessions used only to unlock protected routes in deterministic tests
- Supabase client calls when the goal is to verify branching, error handling, or response shaping in app code
- browser-side fixtures that replace nondeterministic UI prerequisites with stable seeded state

Do not rely on mocks alone when the change is primarily about:

- SQL schema correctness, migrations, indexes, constraints, or RLS behavior
- deployment wiring, scheduled-job invocation, or environment-specific runtime integration
- any bug whose root cause is already known to appear only in the real integration layer

When in doubt, use mocks for fast PR confidence and add the smallest real-integration check that proves the boundary the mock cannot.

## Layer expectations

### Unit tests

Use unit tests for small deterministic logic with clear inputs and outputs.

Expected examples:

- iCalendar formatting helpers
- stable event UID generation
- environment validation helpers
- TMDb payload normalization
- token and watchlist helper logic

### Deterministic integration tests

Use integration tests for server boundaries and module interactions where we want more realism than a pure unit test, but still need deterministic execution.

Expected examples:

- route handlers with mocked upstream dependencies
- Supabase-backed modules tested against mocked clients or disposable test state
- calendar feed endpoint behavior for valid and invalid tokens
- auth and authorization flow with stubbed sessions

### Browser E2E

Use Playwright for the user journeys that matter most once the flow can run deterministically.

Expected examples:

- sign-in or stubbed-session entry
- search for a movie
- add or remove a watchlist item
- manage calendar settings and token rotation

Browser E2E in PR validation should still prefer deterministic fixtures and mocked external dependencies over live services.

### External smoke and post-deploy checks

Use smoke checks after deploy or in environment-specific workflows to confirm the stack works end to end where mocks are insufficient.

Expected examples:

- deployed auth still protects private routes
- the cron endpoint is reachable only with the expected protection
- the hosted calendar feed returns the correct content type and authorization behavior

## Operating rules for feature work

- Add or update the appropriate test coverage in the same PR when the affected behavior is deterministic.
- State expected automated coverage up front in the issue **Testing Expectations** section (see `.github/ISSUE_TEMPLATE/agent_task.md` and `AGENTS.md`).
- State what tests changed (or why none were needed) in the PR **Test Impact** section (see `.github/pull_request_template.md`).
- If a needed browser test is not yet practical, open or link the immediate feature-specific follow-up issue (by number) instead of deferring the gap to a vague umbrella issue.
- Keep all examples, fixtures, and disposable credentials fake or dev-only.
- Do not treat this document as a reason to widen issue scope into CI rewrites or a full testing backlog refresh unless the issue explicitly asks for that.
