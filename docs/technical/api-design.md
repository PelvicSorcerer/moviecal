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
- `POST /api/watchlist/shared/[watchlistId]/invite` — owner-only invitation creation. It revokes existing unrevoked links and returns a newly generated secret URL once; only its token hash is stored. The current operation is sequential rather than atomic, and the current link has no expiration (`expires_at` is null). Seven-day expiry, atomic rotation, and standalone revoke are planned in the Shared Watchlists project.
- `POST /api/watchlist/invite/accept` with `{ token }` — an authenticated recipient accepts a valid secret link and gains editor membership. An existing owner or accepted member receives `joined: false`; an invalid, revoked, or expired link fails. The current lookup and join are separate operations, so revoke/accept race hardening is planned.
- `DELETE /api/watchlist/shared/[watchlistId]/members/[membershipId]` — owner-only removal of one membership from that shared list. Editor self-leave and owner-membership invariants need the planned hardening work.
- `/watchlist` remains the authenticated overview entry point for personal plus shared watchlists.
- `/watchlist/[watchlistId]` is the authenticated detail route for any authorized watchlist. Unauthorized, stale, and missing watchlist ids should fail closed without leaking additional watchlist metadata.
- `/watchlist/invite/[token]` is the authenticated invitation preview/acceptance page; it shows minimal shared-list context before the recipient joins.
- Shared-list rename, list deletion, and editor self-leave are planned, not current endpoints. The additive `v1` API currently serves only personal watchlist operations; its shared-list expansion is tracked separately in Linear and documented in `docs/api/v1-contract.md` when shipped.

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
