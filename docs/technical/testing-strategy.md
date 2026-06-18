# Testing strategy

## Baseline checks

`npm run verify` is the local baseline check. It should run lint, typecheck, unit tests, and production build. Pull-request CI should match this baseline and must not require production secrets.

Database schema verification for Supabase work should use `npm run db:lint`, which wraps `supabase db lint`.

- Prefer `SUPABASE_DB_URL=postgresql://... npm run db:lint` against a disposable or dev-only database when local Docker/Supabase services are unavailable.
- `supabase db lint --local` is still valid when a local Supabase stack is reachable, but it is not guaranteed inside the Codex sandbox because Docker is unavailable here and localhost database access may be blocked.
- The authoritative infra-backed schema gate is `.github/workflows/supabase-verify.yml`, which runs the real DB lint path in GitHub-hosted CI.

## Incremental coverage policy

Automated coverage should be added incrementally with feature delivery rather than deferred to a late broad testing pass.

- Feature PRs should add or update unit and integration coverage in the same PR when the affected logic is deterministic.
- Feature PRs should add or update Playwright coverage as soon as the user flow is deterministic enough to test with mocks or fixtures.
- If Playwright coverage is not yet practical, open an immediate feature-specific follow-up issue before merge instead of deferring the gap to a broad umbrella issue.
- The shared Playwright foundation is a finite setup task; after it lands, future browser-flow coverage should expand per feature.

## Unit tests

Use Vitest for small deterministic units, including:

- iCalendar escaping and formatting.
- Stable UID generation.
- Environment validation helpers.
- TMDb response normalization.
- Watchlist and token helper logic.

## Integration tests

Add integration tests around server boundaries once the relevant modules exist:

- Supabase client helpers with mocked configuration.
- Watchlist data access with mocked Supabase responses or a local test database.
- TMDb wrapper with mocked HTTP responses.
- Calendar feed endpoint behavior for valid and invalid tokens.

## End-to-end tests

Use Playwright for user flows once each flow can run deterministically without production secrets:

- Sign in or stubbed test session.
- Search for a movie.
- Add and remove a watchlist item.
- Open protected calendar settings.
Calendar URL retrieval and feed-content assertions should land with the future token/feed implementation work rather than this foundation issue.

The current smoke-test foundation keeps that scope intentionally finite:

- `npm run e2e` starts the app with `MOVIECAL_E2E_TEST_MODE=1`, which enables an e2e-only stubbed auth/session path and cookie-backed watchlist fixtures for protected server pages and watchlist mutations.
- Playwright should keep external dependencies such as TMDb deterministic through reusable route interception helpers instead of live third-party requests.
- Follow-up feature work should extend the shared fixtures and add targeted browser coverage in the relevant feature issue or PR, rather than treating this foundation task as the permanent bucket for all Playwright tests.

E2E tests should be a focused CI gate only after these fixtures and mocks remain reliable in pull requests.

## Test data and secrets

- Never commit real secrets.
- Prefer mocked TMDb responses for deterministic tests.
- Use local or disposable Supabase test resources only when required and documented.
