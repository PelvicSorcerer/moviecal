# Architecture

High level
- Next.js (App Router) hosts the frontend, the browser cookie-session API routes, and the additive `v1` bearer-token API surface for native/mobile clients.
- Supabase (Postgres) stores users, personal and shared watchlists, watchlist membership and invite records, cached movie metadata, and calendar tokens.
- TMDb is the external movie metadata provider (search and detail endpoints).
- Calendar feed is a server-side API route that returns a text/calendar .ics feed identified by an unguessable per-user token.
- Vercel Cron calls a protected refresh endpoint to update release dates periodically.

Watchlists
- Every user owns exactly one personal watchlist and may also own or be a member of shared watchlists; both kinds live in the same `watchlists` table. Full schema: `docs/technical/data-model.md`.
- Access to a shared watchlist requires an accepted `watchlist_memberships` row (owner or editor role). Invite links are hashed bearer credentials that grant membership; they are not a friend or contact graph. Endpoint surface: `docs/technical/api-design.md`.

Calendar feed
- A calendar token still maps to exactly one user. The feed aggregates movies from every watchlist that user can currently access — their personal watchlist plus any shared watchlist they own or have accepted membership on — and deduplicates repeated movie identity (`tmdb_id`) into a single event when it appears in more than one contributing watchlist. Full aggregation, ordering, and UID rules: `docs/technical/calendar-feed-design.md`.

API surfaces
- Browser: cookie-session routes under `/api/*` (e.g. `/api/watchlist`), backed by a server-side Supabase Auth session in HTTP-only cookies. This remains the web app's only surface.
- Mobile/native: an additive, versioned `v1` surface under `/api/v1/*`, authenticated by `Authorization: Bearer <access-token>` only — it never reads cookies. The current personal-watchlist route validates the bearer identity with a user-scoped client, then uses a server-only service-role client and actor-scoped domain checks for watchlist data. Calendar-token reads and writes use the user-scoped RLS path; movie search has no user-owned data. Full contract: `docs/api/v1-contract.md`.
- The two surfaces coexist; `v1` is additive and does not change or replace the cookie-session routes.

Security boundaries
- Supabase enforces Row Level Security for direct authenticated database access, scoped to ownership and accepted watchlist membership. Routes that query through a server-only service-role client must enforce actor authorization in the application domain. Full authorization model: `docs/technical/auth-and-security.md` and `docs/api/v1-contract.md`.
- TMDb API key and Supabase service-role key remain server-side only and are never checked into the repo or sent to web/native clients.
- Calendar tokens and watchlist invite links are bearer credentials; invite tokens are stored hashed, not raw.

Scalability
- Design keeps feed generation efficient (query accessible watchlists → join cached movie release dates → dedupe by movie identity → stream .ics).
- Cache TMDb responses to minimize API calls and stay within rate limits.

## Versioned shared-watchlist reads (MOV-340)

`GET /api/v1/watchlists` and `GET /api/v1/watchlists/{id}` expose authorized personal/shared summaries and items with `role` and `canEdit`. Bearer identity is validated before service-role construction, with no cookie fallback or token logging. List summaries use caller-scoped RLS; detail uses server-only service-role data access after the same actor-scoped ownership/accepted-membership check as cookie reads. Pending invitees and outsiders receive no shared metadata; forbidden and unknown detail IDs both return 404. Direct user clients remain subject to RLS, and clients never receive service-role keys. The singular personal API remains compatible. Stable IDs, UTC dates, error shapes, and bounded cursor pagination are defined in [v1 contract](../api/v1-contract.md). Native presentation and shared mutation APIs remain separate work.
