# v1 mobile API contract

Status: additive, stable. Introduced in issue #211.

The `v1` surface is a thin, versioned API for native/mobile clients. It is **additive**: the existing unversioned routes under `/api/watchlist` (cookie-session, browser) are unchanged and remain the surface for the web app. During the compatibility period both surfaces coexist; the web app continues to use the cookie-based routes and mobile clients use `v1`.

## Authentication

- **Scheme:** `Authorization: Bearer <access-token>` only. The `v1` routes never read cookies.
- The bearer token is a Supabase access token (JWT). It is validated on every request; an invalid, expired, or missing token yields `401`.
- **No silent refresh.** Bearer tokens have a shorter lifetime than cookie sessions. When a token is expired the API returns `401` and the mobile client is responsible for refreshing and retrying. The server never extends or refreshes the supplied token.
- **Access control is enforced by Postgres RLS.** The request is served through a user-scoped Supabase client built from the bearer token. The `v1` routes never use the service-role key and perform no application-level ownership checks.
- Tokens are never logged or echoed in responses.

## Error shape

All errors use `{ "error": string }` with an appropriate HTTP status:

| Status | Meaning |
|---|---|
| `400` | Invalid request body (`WatchlistInputError`). |
| `401` | Missing, malformed, expired, or otherwise invalid bearer token — `{ "error": "Unauthorized." }`. |
| `403` | Access denied by domain/RLS (`WatchlistAccessError`). |
| `404` | Item or watchlist not found (`WatchlistNotFoundError`). |
| `500` | Unexpected/data error. |
| `503` | TMDb not configured (on write paths that fetch movie metadata). |

## Endpoints

### Watchlist

Base path: `/api/v1/watchlist`. All watchlist endpoints operate on the authenticated user's **personal** watchlist.

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

### `DELETE /api/v1/watchlist`

Removes a movie from the personal watchlist.

- Request body: `{ "watchlistItemId": string }`.
- Response `204`: no body.
- `400` if `watchlistItemId` is missing or not a non-empty string.
- `404` if the item does not exist in the caller's personal watchlist.

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

## Compatibility notes

- The `v1` prefix is a stability boundary. Breaking changes to request/response shapes must be introduced under a new version prefix (`v2`), leaving `v1` intact for already-shipped mobile clients.
- No new environment variables or secrets are introduced by this surface.
