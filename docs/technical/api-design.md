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
- `POST /api/watchlist/shared/[watchlistId]/invite` — owner-only creation or rotation. A caller-scoped database transaction locks the shared-list row, revokes the old link, and inserts a new link expiring seven days after issue. Failure rolls back both changes. Only the hash is persisted; the raw URL is returned once. `DELETE` on the same route revokes the current link through that transaction without creating a replacement. Concurrent owner calls serialize, and a unique partial index permits at most one unrevoked link per list.
- `POST /api/watchlist/invite/accept` with `{ token }` — an authenticated recipient accepts a valid secret link and gains editor membership. An existing owner or accepted member receives `joined: false`; an invalid, revoked, or expired link fails. The current lookup and join are separate operations, so revoke/accept race hardening is planned.
- `DELETE /api/watchlist/shared/[watchlistId]/members/[membershipId]` — owner-only removal of one membership from that shared list via `removeSharedWatchlistMember`. The owner's own membership, other lists' membership ids, and non-owner callers fail with `403`/`404` without changing data.
- `DELETE /api/watchlist/shared/[watchlistId]/membership` — cookie-session editor self-leave via `leaveSharedWatchlist`. Success returns `{ left: true, watchlistId }` and the leaver loses detail, mutation, search-target, and calendar access on the next request. Owners, outsiders, and pending invitees get `403` and nothing changes; a removed editor can rejoin only with a still-valid invite. Member emails stay visible to the owner only.
- `DELETE /api/watchlist/shared/[watchlistId]` — owner-only permanent deletion of a shared watchlist via the shared-domain `deleteSharedWatchlist` operation. Relies on the `"owners can delete shared watchlists"` RLS policy (migration `20260924000000`) as a second enforcement layer behind the app-layer ownership check, so it cascades `watchlist_items`, `watchlist_memberships`, and `watchlist_invite_links` in one statement. A non-owner (including an accepted editor) or a personal-watchlist id fails with `403` and mutates nothing; a movie also saved to another accessible list is unaffected because only the deleted watchlist's own item rows disappear.
- `/watchlist` remains the authenticated overview entry point for personal plus shared watchlists.
- `/watchlist/[watchlistId]` is the authenticated detail route for any authorized watchlist. Unauthorized, stale, and missing watchlist ids should fail closed without leaking additional watchlist metadata.
- `/watchlist/invite/[token]` is the authenticated invitation preview/acceptance page; it shows minimal shared-list context before the recipient joins.
- Shared-list rename is planned, not a current endpoint on this cookie-session surface. The additive `v1` API's shared-list expansion is documented in `docs/api/v1-contract.md`.

## Shared-list deletion: one domain operation, two transports

Permanent owner-only deletion of a shared list is a **shared-domain operation**, `deleteSharedWatchlist` in `src/lib/watchlist/shared.ts` (MOV-373). Both the web cookie-session route above and the native bearer route (`docs/api/v1-contract.md`) call it and map its errors, rather than owning any part of the authorization or cascade contract:

- Success removes the list, its items, its memberships, and its stored invite-token hashes together, and returns the deleted list's summary so a transport can confirm what it removed.
- An accepted editor, an outsider, and any attempt aimed at a personal list all raise `WatchlistAccessError` → `403` with the fixed message `Watchlist access denied.` — no name, member, or item metadata.
- An unknown, already-deleted, or database-filtered target raises `WatchlistNotFoundError` → `404` with `Watchlist not found.` That is also the documented response to a **repeated** delete of the same list.
- `handleDomainError` in `src/lib/api/response.ts` already produces those statuses, so a transport needs no bespoke error mapping.

Former members lose access as a consequence of the cascade, and private calendar feeds reflect it on their next request — see `docs/technical/calendar-feed-design.md`.

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
