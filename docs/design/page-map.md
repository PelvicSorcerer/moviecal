# Page map

Key pages and API routes in the current web app. The shared-list operations below use the signed-in browser session; the additive bearer API is documented in `docs/api/v1-contract.md`.

## Frontend pages

- `/` — landing page and app overview.
- `/sign-in` — sign-in page or Supabase-powered auth entry point.
- `/search` — movie search UI.
- `/watchlist` — authenticated watchlist overview showing the signed-in user's personal watchlist plus shared watchlists they belong to. Personal item management stays on this page for now.
- `/watchlist/[watchlistId]` — authenticated watchlist detail page for a personal or shared watchlist the acting user is authorized to access.
- `/watchlist/invite/[token]` — authenticated preview and acceptance page for a valid shared-list invitation.
- `/settings/calendar` — calendar token management and subscription URL.

## API routes

- `/api/movies/search?q=` — server-side movie search proxy backed by TMDb.
- `/api/watchlist` — authenticated `GET` and `POST` watchlist operations. `POST` may target a specific authorized watchlist with `watchlist_id`; otherwise it falls back to the actor's personal watchlist.
- `/api/watchlist/shared` — authenticated `POST` endpoint for creating a shared watchlist owned by the current user.
- `/api/watchlist/shared/[watchlistId]/invite` — owner-only `POST` to generate or rotate a secret invitation URL.
- `/api/watchlist/invite/accept` — authenticated `POST` to accept a valid invitation as an editor.
- `/api/watchlist/shared/[watchlistId]/members/[membershipId]` — owner-only `DELETE` to remove a member.
- `/api/watchlist/[id]` — authenticated `DELETE` watchlist operation scoped to the requested `watchlist_id` target when present, or the actor's personal watchlist otherwise.
- `/api/calendar/[token]` — public tokenized calendar feed endpoint returning `text/calendar`.
- `/api/cron/refresh-releases` — protected scheduled release-date refresh endpoint.
