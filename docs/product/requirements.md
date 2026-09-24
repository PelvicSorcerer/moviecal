# Requirements

Functional requirements
- Sign-in and user accounts.
- Search movies using TMDb and display results.
- Add and remove movies from the user's personal watchlist.
- Create shared watchlists and view or manage movies in personal/shared watchlists when authorized.
- Provide a web watchlist experience for personal and shared lists without representing it as a complete social product. The current collaboration slice includes owner-generated/rotated secret links, signed-in recipient acceptance as an editor, and owner removal of members.
- Provide a private calendar subscription URL per user that returns an iCalendar feed (.ics).
- Allow a user to rotate their calendar subscription URL; the prior URL must no longer grant feed access.
- Calendar feed must return a single all-day event per known-release movie across the user's accessible watchlists, deduplicated by movie identity.
- Scheduled refresh of release dates (Vercel Cron).
- Provide an additive, versioned v1 API for native/mobile clients while retaining the cookie-session web API for the web app. The current v1 watchlist endpoints address only the user's personal list; shared-list endpoints are planned additions.

Non-functional requirements
- Use TypeScript strict mode.
- Keep hosting on free/personal tiers where possible.
- Calendar feed must be stable, performant, and cache-friendly.

Calendar-specific constraints
- Feed must return Content-Type: text/calendar.
- Feed URL must include an unguessable token mapping to exactly one user.
- Unknown/invalid tokens return 404.
- No interactive login for the feed (clients fetch directly).
- Treat the complete subscription URL as a bearer credential: do not share it or log it.
- Stable event UIDs so clients update events instead of creating duplicates.
- Use all-day DATE events (no time-of-day).
- Skip movies with unknown release dates in MVP calendar output.
- The feed may include movies from the user's personal watchlist and authorized shared watchlists; access changes take effect on a subsequent request.

Security constraints
- Do not expose one user's watchlist to another.
- Use Supabase Row Level Security for watchlist data.
- Service role keys only server-side; public anon key only where appropriate.
- Never commit secrets or .env files to the public repo.
- Invite links are bearer credentials: store their hashes rather than raw tokens and avoid logging or exposing the URL after generation. Current web acceptance and owner member removal must follow the permissions in the [API design](../technical/api-design.md). Seven-day expiry, standalone revoke, editor leave, shared rename, and list deletion are planned rather than current requirements of the shipped slice.

Authoritative detail
- [API design](../technical/api-design.md) is authoritative for web API behavior and authorization.
- [Calendar feed design](../technical/calendar-feed-design.md) is authoritative for calendar aggregation, deduplication, token rotation, and event identity.
- [v1 mobile API contract](../api/v1-contract.md) is authoritative for the additive mobile API, including bearer-token handling.
