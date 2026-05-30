# MVP scope

Included in MVP
- User sign-in (Supabase).
- TMDb-backed movie search UI.
- Add/remove movies to a per-user watchlist.
- Watchlist page (list of movies and known release dates).
- Generate private calendar subscription URL (unguessable token).
- Calendar feed endpoint that returns text/calendar .ics with one all-day event per watchlisted movie with known release date.
- Scheduled refresh of release dates (Vercel Cron + protected endpoint).
- Stable event UIDs so calendar clients update events.

Out of scope for MVP (see non-goals)
- Social features, sharing between users, native mobile apps, or push notifications.
