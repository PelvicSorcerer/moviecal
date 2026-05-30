# Calendar feed design

Format
- Feed uses iCalendar (.ics), Content-Type: text/calendar.
- Each watchlisted movie with a known release_date appears as one VEVENT with an all-day DATE DTSTART (use DTSTART;VALUE=DATE:YYYYMMDD).
- Use stable UIDs so clients update events rather than creating duplicates.
- Movies with unknown release dates are skipped for MVP.

Token and access
- Feed URL contains an unguessable token that maps to exactly one user (e.g., /api/calendar/<token>.ics).
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
