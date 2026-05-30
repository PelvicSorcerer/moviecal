# Page map

Frontend pages and API routes (Next.js App Router):

Frontend pages
- / — Landing / app overview
- /sign-in — Optional explicit sign-in page (or built-in Supabase UI)
- /search — Movie search UI (client/server search via API)
- /movies/[tmdb_id] — Movie detail view
- /watchlist — User's saved movies
- /settings — Calendar token management (regenerate)

API routes
- /api/tmdb/search?q= — Server-side TMDb search proxy
- /api/tmdb/movie/[tmdb_id] — Server-side movie detail fetch and cache
- /api/watchlist — GET/POST authenticated watchlist operations
- /api/watchlist/[id] — DELETE authenticated remove
- /api/calendar/[token].ics — Public calendar feed endpoint (text/calendar)
- /api/refresh — Protected endpoint for scheduled release-date refresh (called by Vercel Cron or internal job)
