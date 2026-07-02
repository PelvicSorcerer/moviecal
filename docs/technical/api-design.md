# API design

## Authentication

Use Supabase auth for all interactive user-scoped endpoints. Frontend code may use client-safe Supabase values where appropriate; server-side code may use service-role credentials only in server-only modules.

## Public calendar endpoint

- `GET /api/calendar/[token]`
  - Public, no interactive auth.
  - The generated subscription URL should be presented to users as a calendar feed URL and may include an `.ics` suffix in the tokenized path when implemented.
  - Returns `200` with `Content-Type: text/calendar; charset=utf-8` for a valid token.
  - Returns `404` for an invalid token.
  - Returns one all-day `VEVENT` per watchlisted movie with a known `release_date`.
  - Aggregates movies from the token owner's personal watchlist plus every shared watchlist they can still access under the MVP rule documented in `docs/technical/calendar-feed-design.md`.
  - Deduplicates the same `tmdb_id` across included watchlists before event generation.

## Authenticated user endpoints

- `GET /api/watchlist` — returns the authenticated user's personal watchlist with joined movie metadata.
- `POST /api/watchlist` with `{ tmdb_id, watchlist_id? }` — adds a movie to the authenticated user's personal watchlist by default, or to a specific authorized personal/shared watchlist when `watchlist_id` is supplied. Duplicate adds remain a no-op only within the targeted watchlist.
- `POST /api/watchlist/shared` with `{ name }` — creates a shared watchlist owned by the authenticated user and returns the new watchlist summary.
- `DELETE /api/watchlist/[id]?watchlist_id=` — removes one item from the explicitly targeted authorized watchlist, or from the authenticated user's personal watchlist when no target is provided. Deleting from one watchlist must not remove the same movie from any other watchlist.
- `/watchlist` remains the authenticated overview entry point for personal plus shared watchlists.
- `/watchlist/[watchlistId]` is the authenticated detail route for any authorized watchlist. Unauthorized, stale, and missing watchlist ids should fail closed without leaking additional watchlist metadata.
- Invite acceptance and membership-management endpoints remain deferred even though shared-watchlist detail now exists.

## Server-only/protected endpoints

- `GET /api/cron/refresh-releases` — protected Vercel Cron entrypoint for scheduled release-date refresh. It must be callable only by the configured scheduler or trusted server-side process.
- `POST /api/cron/refresh-releases` — protected fallback entrypoint for trusted server-side callers that need to trigger the same refresh path outside Vercel Cron.

## TMDb proxy endpoints

- `GET /api/movies/search?q=` — server-side TMDb search proxy.
- Future movie-detail route shape should be decided with the TMDb wrapper task; prefer keeping all TMDb-facing code server-only.

## Error handling

- Use standard HTTP status codes: `400`, `401`, `403`, `404`, and `500`.
- Calendar feed returns `404` for unknown tokens to avoid leaking token existence details via authorization differences.
- API errors must not include secrets, raw service-role keys, TMDb keys, raw invite tokens, or private calendar tokens.
