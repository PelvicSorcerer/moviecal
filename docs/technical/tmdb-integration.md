# TMDb integration

API usage
- Use TMDb Search for discovery and TMDb Movie Details for accurate release_date data.
- Keep the TMDb API key server-side only; never publish it in the frontend or repo.
- Web search accepts `GET /api/movies/search?q=title&page=2`, with an optional integer `page` from 1 to 500 (default 1). Invalid pages return HTTP 400 with an `error` string.
- Responses contain normalized `results`, `page`, `totalPages` (capped at TMDb's 500-page limit), and `totalResults`. Missing or invalid TMDb totals fall back to the page's result count. The web UI shows the total match count, falling back to the loaded count if a response omits the total and never showing fewer than the loaded count. It explicitly loads subsequent pages, de-duplicates movies by TMDb ID, and preserves loaded results for retry after a paging failure. Legacy responses without paging metadata remain single-page results.
- `searchMoviesPage` exposes paging metadata; `searchMovies` preserves the array-only contract used by `/api/v1/movies/search`.

Caching and rate limits
- Cache search results and movie details in the local movies table (raw_json + release_date) to limit TMDb calls.
- Refresh cached release_date with the refresh job (Vercel Cron) rather than on every calendar request.
- Respect TMDb rate limits; back off and queue retries for failures.

Mapping
- Store tmdb_id, title, release_date, poster_path, and a raw JSON blob.
- Prefer release_date from TMDb movie details endpoint; fall back to search result when necessary.
