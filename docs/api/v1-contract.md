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

Base path: `/api/v1/watchlist`. The singular path remains the authenticated user's **personal** item API. The plural read endpoints below additionally expose authorized personal and shared lists. Shared mutations remain on the cookie-session web surface.

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
