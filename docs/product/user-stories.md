# User stories

- As a user, I can sign in so my watchlist is private. (Acceptance: sign-in via Supabase works.)
- As a user, I can search for movies (TMDb) so I can find titles to follow. (Acceptance: search returns results matching query.)
- As a user, I can add a movie to my watchlist. (Acceptance: record created and visible only to me.)
- As a user, I can remove a movie from my watchlist. (Acceptance: removed and no longer appears in my feed.)
- As a user, I can view my watchlist. (Acceptance: list shows added movies and release dates if known.)
- As a user, I can get a private calendar subscription URL. (Acceptance: unique, unguessable URL is shown.)
- As a user, I can subscribe to the URL from iOS Calendar and see one all-day event per movie with a known release date. (Acceptance: iCal downloads and contains DATE events.)
- As a system admin (internal), scheduled refresh updates release dates and the feed reflects changes. (Acceptance: changed dates update event DTSTART values and clients reconcile them.)
