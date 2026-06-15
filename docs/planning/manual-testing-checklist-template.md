# Manual testing checklist template

Use this template when the orchestrator hands an implementation branch to a human tester for local verification.

Manual testing should happen on the pushed orchestrator-owned issue branch before the PR is promoted to ready for review. A draft PR may exist earlier for visibility, but draft status does not replace the checklist.

## Template

- Issue: `#[ISSUE_NUMBER] [ISSUE_TITLE]`
- Branch to test: `[BRANCH_NAME]`
- Environment/setup assumptions:
  - `[Required auth state, test user, seed data, env vars, feature flags]`
- Happy-path checks:
  - `[Primary user flow step 1]`
  - `[Primary user flow step 2]`
  - `[Primary user flow step 3]`
- Edge cases:
  - `[Boundary or alternate path 1]`
  - `[Boundary or alternate path 2]`
- Regression checks:
  - `[Nearby behavior that must still work 1]`
  - `[Nearby behavior that must still work 2]`
- Expected results:
  - `[Observable success condition 1]`
  - `[Observable success condition 2]`
- Notes for the orchestrator:
  - `[Known gaps, flaky areas, or follow-up bugs to file if found]`

## Example skeleton

- Issue: `#123 Add watchlist search filters`
- Branch to test: `agent/123-watchlist-search-filters`
- Environment/setup assumptions:
  - Signed in with the disposable Supabase test account.
  - TMDb and Supabase local environment variables are populated.
  - At least three watchlist movies exist with different release dates.
- Happy-path checks:
  - Open `/watchlist` and confirm the page loads without an auth or data error.
  - Apply a title filter and confirm matching rows update immediately.
  - Clear the filter and confirm the full list returns.
- Edge cases:
  - Apply a filter that matches no movies and confirm the empty state is clear.
  - Refresh the page with a filter applied and confirm state behaves as designed.
- Regression checks:
  - Remove a movie from the watchlist and confirm the list updates correctly.
  - Open a movie details path from the filtered list and confirm navigation still works.
- Expected results:
  - Filtering changes only the signed-in user's visible watchlist data.
  - Empty, loading, and error states are understandable and do not expose raw internals.
- Notes for the orchestrator:
  - If auth redirects unexpectedly, capture the exact path and whether the session existed before reload.
