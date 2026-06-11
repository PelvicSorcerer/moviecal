# Testing strategy

## Baseline checks

`npm run verify` is the local baseline check. It should run lint, typecheck, unit tests, and production build. Pull-request CI should match this baseline and must not require production secrets.

Database schema verification for Supabase work should use `npm run db:lint`, which wraps `supabase db lint`.

- Prefer `SUPABASE_DB_URL=postgresql://... npm run db:lint` against a disposable or dev-only database when local Docker/Supabase services are unavailable.
- `supabase db lint --local` is still valid when a local Supabase stack is reachable, but it is not guaranteed inside the Codex sandbox because Docker is unavailable here and localhost database access may be blocked.

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

Use Playwright for main user flows after auth, search, watchlist, and calendar feed behavior can run deterministically without production secrets:

- Sign in or stubbed test session.
- Search for a movie.
- Add and remove a watchlist item.
- Retrieve a calendar URL.
- Fetch calendar feed and assert expected `VEVENT` output.

E2E tests should be a focused CI gate only after test fixtures and mocks make them reliable in pull requests.

## Test data and secrets

- Never commit real secrets.
- Prefer mocked TMDb responses for deterministic tests.
- Use local or disposable Supabase test resources only when required and documented.
