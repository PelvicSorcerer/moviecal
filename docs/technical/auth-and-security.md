# Auth and security

## Supabase

- Use Supabase Auth for user sign-in and identity.
- Email/password is sufficient for MVP; OAuth can be added later if needed.
- Enforce Row Level Security on user-owned and membership-scoped tables so users can only read and write rows authorized by owned watchlists, accepted memberships, or server-side bearer-token flows.
- Client-safe Supabase values may be exposed to browser code when prefixed with `NEXT_PUBLIC_`.
- The Supabase service-role key stays server-side only and must never be committed.
- The app session should be established server-side with HTTP-only cookies so protected pages and API routes do not rely on client-only auth checks.

## iOS client

- The iOS app authenticates via `supabase-swift`'s `Auth` module (email/password), added in `MOV-106`.
- The Supabase session (access + refresh token) is persisted exclusively via `Auth.KeychainLocalStorage`, namespaced under the `com.moviecal.ios.supabase-auth` Keychain service — never in `UserDefaults`, a file, or logs.
- The app ships only the Supabase anon/publishable key (`MoviecalSupabaseAnonKey` in `Info.plist`), never the service-role key.
- Per `docs/api/v1-contract.md`, the `v1` API layer never refreshes a bearer token itself. The iOS token provider (`SupabaseAuthTokenProvider`) asks the Supabase auth client for a non-expired session on every `v1` request; if the refresh token itself is no longer valid, it throws so the app surfaces re-authentication instead of retrying silently.

## Watchlist authorization

- `watchlists`, `watchlist_memberships`, and `watchlist_invite_links` are the watchlist authorization primitives.
- A user's personal watchlist remains owned by that user, but future shared watchlists must compose through memberships and invite links rather than any future friend or contact system.
- Accepted membership rows are the RLS boundary for reading and editing watchlist items.
- Ownership remains explicit on `watchlists.owner_user_id`; non-owner memberships can edit only when their membership role allows it.
- The current personal-watchlist app path may continue to use the compatibility `watchlist_items.user_id` bridge during migration, but new schema assumptions should treat `watchlist_items.watchlist_id` as the real ownership link.
- The ownership invariants themselves are enforced in the database, not only in route handlers: owner and kind are immutable, personal watchlists are undeletable while their owner exists, the owner's membership row cannot be removed, demoted, un-accepted, or reassigned, and an accepted editor may change only a shared watchlist's name. See `docs/technical/data-model.md` for the full list and `supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql` for the implementation.
- `removeSharedWatchlistMember` refuses the owner's membership before it reaches Supabase, and `listSharedWatchlistMembers` renders the owner row under a synthetic `owner:<user-id>` id so the real owner membership id never reaches a client that could aim a removal request at it. The database trigger is the authority; these are the fast, legible refusals in front of it.
- `deleteSharedWatchlist` is the single owner-only permanent-deletion operation, shared by every transport. It refuses an accepted editor, an outsider, and any personal-list target before attempting a write, and its refusals carry a fixed message with no list, member, or item metadata. The delete itself goes through the **RLS-scoped user client** — not the service-role client — so the `owners can delete shared watchlists` policy is an independent refusal behind the application check, and the statement additionally pins the owner and `kind = 'shared'`. Items, memberships, and stored invite-token hashes go with the list in one transaction, so a removed member has no residual access and a leaked invite token for a deleted list resolves to nothing. See `docs/technical/data-model.md` for the persistence contract.
- `ensure_personal_watchlist_for_user()` is `SECURITY DEFINER` and executable by `authenticated`, so PostgREST exposes it as an RPC; it now refuses any target other than `auth.uid()`, which stops a signed-in user creating a personal watchlist for an arbitrary account and learning its id. A null `auth.uid()` is the trusted server-only path, reachable only through the service-role client, which is never shipped to a browser. The three membership and ownership predicates also bind their user argument to `auth.uid()`, preventing cross-user RPC probes.

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
