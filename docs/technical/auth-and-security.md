# Auth and security

## Supabase

- Use Supabase Auth for user sign-in and identity.
- Email/password is sufficient for MVP; OAuth can be added later if needed.
- Enforce Row Level Security on user-owned and membership-scoped tables so users can only read and write rows authorized by owned watchlists, accepted memberships, or server-side bearer-token flows.
- Client-safe Supabase values may be exposed to browser code when prefixed with `NEXT_PUBLIC_`.
- The Supabase service-role key stays server-side only and must never be committed.
- The app session should be established server-side with HTTP-only cookies so protected pages and API routes do not rely on client-only auth checks.

## Watchlist authorization

- `watchlists`, `watchlist_memberships`, and `watchlist_invite_links` are the watchlist authorization primitives.
- A user's personal watchlist remains owned by that user, but future shared watchlists must compose through memberships and invite links rather than any future friend or contact system.
- Accepted membership rows are the RLS boundary for reading and editing watchlist items.
- Ownership remains explicit on `watchlists.owner_user_id`; non-owner memberships can edit only when their membership role allows it.
- The current personal-watchlist app path may continue to use the compatibility `watchlist_items.user_id` bridge during migration, but new schema assumptions should treat `watchlist_items.watchlist_id` as the real ownership link.

## Invite links

- Watchlist invite links are bearer credentials and must be treated with the same care as calendar tokens.
- Store only hashed invite tokens in `watchlist_invite_links.token_hash`; compare them server-side when invite acceptance is implemented.
- Invite links must not imply user search, contact discovery, or a friend graph.
- RLS should keep invite-link rows owner-scoped for interactive reads and writes; token resolution should happen through trusted server-side access.

## Calendar tokens

- Calendar feed URLs are bearer credentials.
- Store unguessable tokens server-side in `calendar_tokens.token`.
- Token is the only credential required to fetch the public calendar feed; do not require an interactive user session for the feed endpoint.
- Allow users to rotate tokens; rotation invalidates the previous URL.
- Do not log full token values.

## Server secrets

Use environment variables and hosting-provider secret stores. The placeholder names are listed in `.env.example`.

Server-only secrets include:

- `SUPABASE_SERVICE_ROLE_KEY`
- `TMDB_API_KEY`
- `CRON_SECRET`

## Protecting scheduled jobs

- Protect `/api/cron/refresh-releases` with a secret header or an equivalent trusted scheduler mechanism.
- Vercel Cron invokes the configured path with `GET` and automatically sends `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set in the project environment.
- The route accepts `Authorization: Bearer <CRON_SECRET>` and keeps a fallback `x-cron-secret` header for trusted server-side callers outside Vercel Cron.
- Reject unauthorized refresh attempts.
- Avoid returning sensitive refresh details to unauthorized callers.

## Logging and monitoring

- Log enough context to debug failures without logging secrets, raw invite tokens, or full calendar tokens.
- Consider rate limiting for public calendar feed requests.
- Monitor refresh failures and TMDb rate-limit responses.
