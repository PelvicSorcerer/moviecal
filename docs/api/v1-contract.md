# v1 mobile API contract

Status: additive, stable. Introduced in issue #211.

The `v1` surface is a thin, versioned API for native/mobile clients. It is **additive**: the existing unversioned routes under `/api/watchlist` (cookie-session, browser) are unchanged and remain the surface for the web app. During the compatibility period both surfaces coexist; the web app continues to use the cookie-based routes and mobile clients use `v1`.

## Authentication

- **Scheme:** `Authorization: Bearer <access-token>` only. The `v1` routes never read cookies.
- The bearer token is a Supabase access token (JWT). It is validated on every request; an invalid, expired, or missing token yields `401`.
- **No silent refresh.** Bearer tokens have a shorter lifetime than cookie sessions. When a token is expired the API returns `401` and the mobile client is responsible for refreshing and retrying. The server never extends or refreshes the supplied token.
- **Authorization depends on the operation.** The personal-watchlist route uses a user-scoped client to validate identity and call `ensure_personal_watchlist_for_user` — which, since MOV-330, refuses any target other than the caller's own id unless `auth.uid()` is null (the server-only path) — then uses a server-only service-role client for watchlist, item, movie, and membership data access. Its domain operations check the authenticated actor's access through `getWatchlistAccess`; those service-role queries do not rely on RLS for isolation. Direct authenticated database calls remain subject to RLS. The service-role key is never sent to a client.
- Calendar-token `GET` and `POST` use the user-scoped, RLS-enforced client for their interactive token reads and writes. The repository also receives a server-only service-role client, but those operations do not use it for the caller's token access.
- Movie search requires a valid bearer token but does not read user-owned data.
- Tokens are never logged or echoed in responses.

## Error shape

All errors use `{ "error": string }` with an appropriate HTTP status:

| Status | Meaning |
|---|---|
| `400` | Invalid request body, pagination limit/cursor (`WatchlistInputError`), or missing/empty search query `q`. |
| `401` | Missing, malformed, expired, or otherwise invalid bearer token — `{ "error": "Unauthorized." }`. |
| `403` | Access denied by domain/RLS (`WatchlistAccessError`). |
| `404` | Item or watchlist not found (`WatchlistNotFoundError`). |
| `500` | Unexpected/data error. |
| `503` | TMDb not configured (write paths that fetch movie metadata, and the movie search path). |

## Endpoints

### Watchlist

Base path: `/api/v1/watchlist`. The singular path remains the authenticated user's **personal** item API. The plural read endpoints below additionally expose authorized personal and shared lists. Shared-list create and rename are published below; other shared mutations remain on the cookie-session web surface.

### `GET /api/v1/watchlist`

Returns the authenticated user's personal watchlist items.

- Request body: none.
- Response `200`:

  ```json
  {
    "items": [
      {
        "id": "watchlist-item-1",
        "addedAt": "2026-06-13T05:00:00.000Z",
        "movie": {
          "id": 42,
          "tmdbId": 603,
          "title": "The Matrix",
          "releaseDate": "1999-03-31",
          "posterPath": "/matrix.jpg",
          "overview": "A hacker discovers the truth."
        }
      }
    ]
  }
  ```

### `POST /api/v1/watchlist`

Adds a movie to the personal watchlist.

- Request body: `{ "tmdbId": number }`.
- Response `201`: `{ "item": WatchlistItem }` (same shape as an element of `items` above).
- `400` if `tmdbId` is missing or not a number.
- **Idempotent-looking for a duplicate `tmdbId`:** re-adding a movie already on the caller's personal watchlist still returns `201` with the existing item, not an error (`addWatchlistItem` in `src/lib/watchlist/items.ts` falls back to the pre-existing row on a unique-constraint conflict). Clients cannot distinguish a fresh insert from a duplicate from this response alone and should not try to.

### `DELETE /api/v1/watchlist`

Removes a movie from the personal watchlist.

- Request body: `{ "watchlistItemId": string }`.
- Response `204`: no body.
- `400` if `watchlistItemId` is missing or not a non-empty string.
- `404` if the item does not exist in the caller's personal watchlist.

### Shared and personal list reads

`GET /api/v1/watchlists` returns `{ watchlists: WatchlistView[], page: Page }`.
`GET /api/v1/watchlists/{id}` returns `{ watchlist: WatchlistView, items: WatchlistItem[], page: Page }`.
Neither endpoint accepts a body.

- `WatchlistView`: `{ id: string, kind: "personal" | "shared", name: string, ownerUserId: string, role: "owner" | "editor", canEdit: boolean }`.
- `Page`: `{ limit: number, nextCursor: string | null }`.
- Item and movie shapes match the personal API above. List/item IDs are stable database IDs; movie `id` is the database integer and `tmdbId` is TMDb identity. Shared read `addedAt` is UTC ISO-8601 with `Z`; release dates remain `YYYY-MM-DD` or `null`. The singular personal API preserves its existing stored timestamp spelling.
- Optional `limit` defaults to 50 (absent/blank) and accepts integers 1–100. Optional `cursor` is an opaque canonical base64url encoding of the last returned row ID. Send `nextCursor` unchanged for the next page; `null` ends pagination.
- Lists are ordered personal first, then ascending list ID. Items are newest `addedAt` first, then ascending item ID for ties. Pagination applies to the currently authorized collection, not a frozen snapshot: concurrent additions may require restarting; deleted/revoked cursor rows produce `400` with `{ "error": "Invalid pagination cursor." }`.
- Owner and accepted editor see shared lists; pending invitees and outsiders do not. Detail returns identical `404` `{ "error": "Watchlist not found." }` for forbidden and nonexistent lists. Invalid bearer returns `401` before repository construction. Pagination errors return `400`; unexpected errors return `500`, always using the common error shape.

**Authorization boundary:** Both transports call the same actor-scoped `listUserWatchlists` / `getWatchlistDetail` domain rules. List summaries use caller-scoped RLS queries (ownership or accepted membership). Detail validates access through `getWatchlistAccess` before reading items with the server-only service-role client. That path relies on domain authorization, not RLS. Service-role construction occurs only after bearer validation; no cookie fallback, token refresh, or token logging is introduced. Direct authenticated database clients remain RLS-enforced. The service-role key never reaches clients.

### Target-scoped item add and remove

Bearer-only, for any list the caller may edit (personal, or shared as owner or accepted editor). Both use the same `addWatchlistItem` / `removeWatchlistItem` domain rules and TMDb movie validation as the web `/api/watchlist` routes.

`POST /api/v1/watchlists/{watchlistId}/items` with body `{ "tmdbId": number }`.

- `201` `{ "created": true, "item": WatchlistItem, "watchlist": WatchlistView }` for a new item.
- `200` `{ "created": false, "item": WatchlistItem, "watchlist": WatchlistView }` when the movie is already on the list. The response carries the existing item; no second item is ever created, so a client may safely retry a timed-out add or race another editor adding the same movie.
- `400` for a missing/non-integer/non-positive `tmdbId` or invalid JSON; TMDb failures pass through their status (e.g. `404` unknown movie) and `503` when TMDb is unconfigured.

`DELETE /api/v1/watchlists/{watchlistId}/items/{itemId}`

- `204` no body when the item was removed.
- `404` `{ "error": "Watchlist item not found." }` if the item is not on that list. A retry of a successful remove therefore returns `404`; clients should treat that as "already removed".

Both: `401` for a missing/invalid bearer. A pending invitee, outsider, or user who lost access gets the same `404` `{ "error": "Watchlist not found." }` as for an unknown list, and nothing is changed. The singular personal `/api/v1/watchlist` and `/api/v1/movies/search` paths are unchanged.

### `DELETE /api/v1/watchlists/{id}`

Permanently deletes a shared watchlist the caller owns, with its items, memberships, and invite links. There is no undo. It calls the same `deleteSharedWatchlist` domain operation as the web surface, so authorization and cascade behavior are identical.

- Request body: none.
- Response `204`: no body.
- `401` `{ "error": "Unauthorized." }` for a missing or invalid bearer token; nothing is read or written.
- `403` `{ "error": "Watchlist access denied." }` for an accepted editor, pending invitee, outsider, or any personal list (personal lists are never deletable). The message carries no list metadata and nothing changes.
- `404` `{ "error": "Watchlist not found." }` for an unknown id, or a repeat delete of an already-deleted list.
- Former members lose access on their next request: the list disappears from `GET /api/v1/watchlists`, its detail returns `404`, and events sourced only from that list leave their private calendar feed. A movie also on another accessible list stays in the feed.

### Shared member management

Bearer-only, actor-scoped to the shared-domain operations the web routes use (`listSharedWatchlistMemberProfiles`, `removeSharedWatchlistMember`, `leaveSharedWatchlist`).

- `GET /api/v1/watchlists/{id}/members` (owner only) returns `{ members: { id, userId, role, email, acceptedAt }[] }`, owner first. The owner row's `id` is the synthetic `owner:{userId}`, never the real membership id. Pending invitees appear with `acceptedAt: null`.
- `DELETE /api/v1/watchlists/{id}/members/{membershipId}` (owner only) removes an editor or pending invitee and returns `{ deleted: true, membershipId }`. Unknown or other-list membership IDs, including the synthetic owner ID, return `404` `Watchlist member not found.`; the real owner membership returns `403`.
- `DELETE /api/v1/watchlists/{id}/membership` (accepted editor) removes the caller's own membership and returns `{ left: true, watchlistId }`. The owner cannot leave (`403`).
- An accepted editor attempting an owner-only action gets `403` and no member emails. Outsiders and pending invitees get the same `404` `Watchlist not found.` as an unknown list, and nothing changes. Invalid bearer returns `401` before repository construction.
- Access and calendar contribution end on the next request after removal or leave. Emails are returned only by the owner-only listing.

### Calendar

### `GET /api/v1/calendar-token`

Returns the authenticated user's private calendar subscription URL — the canonical `/api/calendar/[token]` feed URL that iCal/Google Calendar clients subscribe to. This is the bearer-authenticated equivalent of the value the cookie-based `/settings/calendar` page renders.

- Request body: none.
- The token is created on demand when the user has none. The endpoint is idempotent: repeated calls return the same URL until the token is rotated (rotation is a separate endpoint).
- Response `200`:

  ```json
  {
    "subscriptionUrl": "https://moviecal.example/api/calendar/AbC123..."
  }
  ```

- `401` if the bearer token is missing, malformed, expired, or otherwise invalid.

**Security:** the returned `subscriptionUrl` embeds the calendar token, which is a bearer credential for the feed. Treat the whole URL like a password; the server never logs the token or the response body. The token always resolves strictly to the authenticated user (the get/create runs through the user-scoped, RLS-enforced client), so a caller can never obtain another user's URL.

### `POST /api/v1/calendar-token`

Rotates the authenticated user's calendar token, immediately invalidating the previous subscription URL and returning the new one.

- Request body: none.
- Response `200`: `{ "subscriptionUrl": "https://moviecal.example/api/calendar/NewToken..." }` — same shape as `GET`, but the embedded token is new.
- The previous token stops resolving at `/api/calendar/[token]` immediately upon rotation.
- `401` if the bearer token is missing, malformed, expired, or otherwise invalid.

**Security:** rotation revokes the previous token server-side. The new `subscriptionUrl` embeds the new calendar token (a bearer credential). Treat the whole URL like a password; the server never logs the token or the response body. Scoped strictly to the authenticated user via the user-scoped, RLS-enforced client.

### Movie search

Base path: `/api/v1/movies/search`. Bearer-authenticated TMDb movie search for native/mobile clients. The response shape is identical to the unversioned `/api/movies/search` route (which is unchanged); the difference is authentication (bearer, no cookies) and the v1 error shape.

Search does not touch user-owned data — there is no service-role client and no RLS concern — but a valid bearer token is still required.

### `GET /api/v1/movies/search`

Searches TMDb for movies matching the `q` query parameter.

- Query parameter: `q` (required, non-empty after trimming).
- Request body: none.
- Response `200`:

  ```json
  {
    "results": [
      {
        "tmdbId": 603,
        "title": "The Matrix",
        "releaseDate": "1999-03-31",
        "posterPath": "/matrix.jpg",
        "overview": "A hacker discovers the truth."
      }
    ]
  }
  ```

- `400` if `q` is missing or empty — `{ "error": "Search query \"q\" is required." }`.
- `401` if the bearer token is missing, malformed, expired, or invalid — `{ "error": "Unauthorized." }`.
- `503` if TMDb is not configured — `{ "error": "Movie search is unavailable until TMDb is configured." }`.


## Compatibility notes

- The `v1` prefix is a stability boundary. Breaking changes to request/response shapes must be introduced under a new version prefix (`v2`), leaving `v1` intact for already-shipped mobile clients.
- No new environment variables or secrets are introduced by this surface.
