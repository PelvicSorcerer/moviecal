# Requirements

Functional requirements
- Sign-in and user accounts.
- Search movies using TMDb and display results.
- Add and remove movies to a per-user watchlist.
- View a user-specific watchlist UI.
- Provide a private calendar subscription URL per user that returns an iCalendar feed (.ics).
- Calendar feed must return a single all-day event per watchlisted movie when a release date is known.
- Scheduled refresh of release dates (Vercel Cron).

Non-functional requirements
- Use TypeScript strict mode.
- Keep hosting on free/personal tiers where possible.
- Calendar feed must be stable, performant, and cache-friendly.

Calendar-specific constraints
- Feed must return Content-Type: text/calendar.
- Feed URL must include an unguessable token mapping to exactly one user.
- Unknown/invalid tokens return 404.
- No interactive login for the feed (clients fetch directly).
- Stable event UIDs so clients update events instead of creating duplicates.
- Use all-day DATE events (no time-of-day).
- Skip movies with unknown release dates in MVP calendar output.

Security constraints
- Do not expose one user's watchlist to another.
- Use Supabase Row Level Security for watchlist data.
- Service role keys only server-side; public anon key only where appropriate.
- Never commit secrets or .env files to the public repo.
