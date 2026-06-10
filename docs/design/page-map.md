# Page map

Frontend pages and API routes (Next.js App Router):

Current status
- The routes below describe the current scaffold structure.
- Most pages and API handlers are placeholders and should not be treated as implemented product behavior.

Frontend pages
- / — Landing / app overview
- /search — Movie search UI (client/server search via API)
- /watchlist — User's saved movies
- /settings/calendar — Calendar feed token management placeholder

API routes
- /api/movies/search?q= — Placeholder movie search endpoint
- /api/watchlist — Placeholder watchlist endpoint
- /api/calendar/[token] — Placeholder calendar feed endpoint returning `text/calendar`
- /api/cron/refresh-releases — Placeholder scheduled refresh endpoint

Planned but not implemented yet
- `/sign-in` or equivalent Supabase auth UI
- `/movies/[tmdb_id]` detail view
- Authenticated watchlist persistence and delete-by-id operations
- Token rotation and release-date refresh behavior
