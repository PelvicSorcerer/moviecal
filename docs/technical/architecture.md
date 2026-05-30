# Architecture

High level
- Next.js (App Router) hosts the frontend and server-side API routes.
- Supabase (Postgres) stores users, watchlists, cached movie metadata, and calendar tokens.
- TMDb is the external movie metadata provider (search and detail endpoints).
- Calendar feed is a server-side API route that returns a text/calendar .ics feed identified by an unguessable token.
- Vercel Cron calls a protected refresh endpoint to update release dates periodically.

Security boundaries
- Supabase enforces Row Level Security for per-user data.
- TMDb API key and Supabase service_role key remain server-side only (never checked into repo).

Scalability
- Design keeps feed generation efficient (query watchlist → join cached movie release dates → stream .ics).
- Cache TMDb responses to minimize API calls and stay within rate limits.
