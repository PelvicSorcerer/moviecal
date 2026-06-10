# API design

Status
- This document describes the intended API shape for future implementation.
- The current scaffold only includes placeholder handlers and does not implement the behaviors below end to end.

Authentication
- Use Supabase auth for all interactive endpoints. Frontend uses the public anon key where appropriate; server-side uses service role for privileged tasks only.

Public API endpoints
- GET /api/calendar/[token]
  - Public, no interactive auth. Returns 200 with Content-Type: text/calendar for valid token, 404 for invalid.
  - Returns one VEVENT per watchlisted movie with known release_date.

Server-authenticated endpoints (require user session)
- GET /api/watchlist — returns user's watchlist with joined movie metadata.
- POST /api/watchlist { tmdb_id } — adds movie (creates cached movie row as needed) to user's watchlist.
- DELETE /api/watchlist/[id] — removes item from user's watchlist.

Server-only/protected endpoints
- POST /api/cron/refresh-releases — protected endpoint for scheduled refresh of release dates. Must be callable only by a scheduled job (e.g., via a Vercel Cron secret or Supabase function).

TMDb proxy endpoints (server-side only)
- GET /api/movies/search?q=
- Movie detail lookup route to be added when detail-page work begins

Error handling
- Use standard HTTP codes (400, 401, 403, 404, 500).
- Calendar feed returns 404 for unknown tokens (avoid leaking existence via 403 differences).
