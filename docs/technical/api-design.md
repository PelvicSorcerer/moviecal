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

## Authenticated user endpoints

- `GET /api/watchlist` — returns the authenticated user's personal watchlist with joined movie metadata.
- `POST /api/watchlist` with `{ tmdb_id }` — adds a movie to the authenticated user's personal watchlist and creates or updates cached movie metadata as needed.
- `DELETE /api/watchlist/[id]` — removes one item from the authenticated user's personal watchlist.
- Shared-watchlist endpoints are intentionally deferred. The multi-watchlist schema is the source of truth now, but current API behavior stays personal-watchlist scoped until the later shared-watchlist app-layer issues land.

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
