# TMDb integration

API usage
- Use TMDb Search for discovery and TMDb Movie Details for accurate release_date data.
- Keep the TMDb API key server-side only; never publish it in the frontend or repo.

Caching and rate limits
- Cache search results and movie details in the local movies table (raw_json + release_date) to limit TMDb calls.
- Refresh cached release_date with the refresh job (Vercel Cron) rather than on every calendar request.
- Respect TMDb rate limits; back off and queue retries for failures.

Mapping
- Store tmdb_id, title, release_date, poster_path, and a raw JSON blob.
- Prefer release_date from TMDb movie details endpoint; fall back to search result when necessary.
