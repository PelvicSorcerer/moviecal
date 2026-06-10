# moviecal

moviecal is a personal movie watchlist web app scaffold for building a private iCalendar (`.ics`) feed of movie release dates. The intended product is a movie watchlist plus a user-specific calendar subscription URL that works with iOS Calendar and other standard iCal clients.

Status: Scaffold complete. MVP implementation is planned but not implemented yet.

Planned tech stack: Next.js (App Router, TypeScript strict), Tailwind CSS, Supabase (auth & DB), TMDb API, Vercel (hosting + Cron), Vitest, Playwright, GitHub Actions.

Docs: See the [docs README](docs/README.md) for product, design, technical, and planning notes.

Security: This is a public repository. Do NOT commit secrets (API keys, service role keys, `.env` files) to this repo. See [docs/technical/auth-and-security.md](docs/technical/auth-and-security.md) for details.

Local development
1. `npm install`
2. Copy `.env.example` to `.env.local`
3. `npm run dev`
4. `npm run verify`

Current scaffold notes
- The current app routes are early placeholders for `/`, `/search`, `/watchlist`, and `/settings/calendar`.
- Supabase auth, TMDb search, persistent watchlists, calendar token rotation, and release-date refresh behavior are planned but not implemented yet.
- The scaffold includes placeholder API routes for movie search, watchlist, calendar output, and scheduled refresh. They are not production-ready feature implementations.
- Planning docs in `docs/planning/` describe intended execution order and issue hygiene. They are not progress trackers.
