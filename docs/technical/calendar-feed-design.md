# Calendar feed design

Format
- Feed uses iCalendar (.ics), Content-Type: text/calendar.
- Each watchlisted movie with a known release_date appears as one VEVENT with an all-day DATE DTSTART (use DTSTART;VALUE=DATE:YYYYMMDD).
- Use stable UIDs so clients update events rather than creating duplicates.
- Movies with unknown release dates are skipped for MVP.

Token and access
- Feed URL contains an unguessable token that maps to exactly one user. The canonical API route is `/api/calendar/[token]`; the user-facing subscription URL may use a token value or suffix that calendar clients recognize as an `.ics` feed.
- Unknown or invalid tokens return HTTP 404.
- Do not require interactive login; the token is the authorization mechanism.
- Tokens should be rotatable by the user (regenerate endpoint in /settings).

UID strategy
- Generate deterministic, stable UIDs server-side so an event for the same user/movie identity keeps the same UID across feed generations.
- Recommended approach:
  - UID = SHA256(CONCAT(user_id, ":", tmdb_id)) + "@moviecal"
- Do not derive UID from token value because token rotation should not force event identity churn.

Event content
- SUMMARY: movie title (include year optional)
- DESCRIPTION: optional TMDb URL and overview snippet
- DTSTART;VALUE=DATE: YYYYMMDD (all-day event)
- DTSTAMP: use server timestamp when generating the feed
- STATUS: CONFIRMED

Caching
- Set caching headers (ETag or Last-Modified) to allow clients to avoid re-downloading unchanged feeds.
- Keep feeds small; only include movies with known release_date.

Privacy
- Do not leak other users' data. The token->user mapping must be strict and validated server-side.

Watchlist aggregation (MVP)
- A calendar token still maps to exactly one user. The feed aggregates movies from every watchlist that user can access at request time.
- Contributing watchlists match the same scope as `listUserWatchlists`:
  - the token owner's personal watchlist
  - shared watchlists owned by the token owner
  - shared watchlists where the token owner has accepted membership
- Excluded watchlists:
  - other users' personal watchlists
  - shared watchlists without accepted membership
  - revoked or expired invite-only access
- The feed emits one all-day event per movie (`tmdb_id`) across all contributing watchlists.
- When the same movie appears in multiple included watchlists, choose one canonical item deterministically:
  1. personal-watchlist items win over shared-watchlist items
  2. otherwise keep the earliest `added_at`
  3. otherwise keep the lexicographically smallest watchlist item id
- Event UIDs remain `SHA256(user_id + ":" + tmdb_id) + "@moviecal"` so duplicate source items do not create duplicate calendar events.
- If membership or ownership changes remove a watchlist from the accessible set, its movies stop contributing to the feed on the next request.
