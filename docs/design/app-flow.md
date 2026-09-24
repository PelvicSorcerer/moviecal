# App flow

1. User lands on home page and can sign in via Supabase.
2. Authenticated user opens the Movie Search page and searches TMDb.
3. From search results, user views details and can add a movie to their personal watchlist or an authorized shared watchlist.
4. Watchlist overview shows the personal list and accepted shared lists; each detail page shows saved movies and cached release dates when available.
5. A shared-list owner can generate or rotate a secret invite URL. A signed-in recipient reviews the invite, accepts editor membership, and can then edit shared movies. The owner can remove a member. Seven-day expiry, editor leave, shared rename, and list deletion are planned later.
6. Settings page exposes the user's private calendar subscription URL (unguessable token). That feed combines currently accessible personal and shared movies and deduplicates the same movie across lists.
7. User subscribes to the URL in iOS Calendar; the client fetches the .ics periodically.
8. A scheduled refresh job updates release dates for tracked movies; if dates change, subsequent .ics output reflects updates and clients update existing events thanks to stable UIDs.
