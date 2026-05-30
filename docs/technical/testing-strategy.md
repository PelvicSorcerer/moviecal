# Testing strategy

Unit tests
- Use Vitest for unit tests of utilities: UID generation, iCal formatting, and small server helpers.

End-to-end tests
- Use Playwright to test main user flows: sign-in (stubbed), search, add/remove watchlist, retrieve calendar URL, fetch .ics and assert correct VEVENTs.

CI
- Run lint, Vitest unit tests, and Playwright E2E in GitHub Actions on pull requests.

Test data and secrets
- Use test keys and test Supabase project for CI; never commit real secrets to the repo.
- Mock TMDb responses for deterministic E2E tests where appropriate.
