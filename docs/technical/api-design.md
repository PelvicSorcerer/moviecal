# API design

Authentication
- Use Supabase auth for all interactive endpoints. Frontend uses the public anon key where appropriate; server-side uses service role for privileged tasks only.

Public API endpoints
- GET /api/calendar/[token].ics
  - Public, no interactive auth. Returns 200 with Content-Type: text/calendar for valid token, 404 for invalid.
  - Returns one VEVENT per watchlisted movie with known release_date.

Server-authenticated endpoints (require user session)
- GET /api/watchlist — returns user's watchlist with joined movie metadata.
- POST /api/watchlist { tmdb_id } — adds movie (creates cached movie row as needed) to user's watchlist.
- DELETE /api/watchlist/[id] — removes item from user's watchlist.

Server-only/protected endpoints
- POST /api/refresh — protected endpoint for scheduled refresh of release dates. Must be callable only by a scheduled job (e.g., via a Vercel Cron secret or Supabase function).

TMDb proxy endpoints (server-side only)
- GET /api/tmdb/search?q=
- GET /api/tmdb/movie/[tmdb_id]

Error handling
- Use standard HTTP codes (400, 401, 403, 404, 500).
- Calendar feed returns 404 for unknown tokens (avoid leaking existence via 403 differences).
