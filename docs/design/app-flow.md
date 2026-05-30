# App flow

1. User lands on home page and can sign in via Supabase.
2. Authenticated user opens the Movie Search page and searches TMDb.
3. From search results, user views details and can add a movie to their watchlist.
4. Watchlist page shows all saved movies; each entry includes cached release date if available.
5. Settings page exposes a private calendar subscription URL (unguessable token).
6. User subscribes to the URL in iOS Calendar; the client fetches the .ics periodically.
7. A scheduled refresh job updates release dates for tracked movies; if dates change, subsequent .ics output reflects updates and clients update existing events thanks to stable UIDs.
