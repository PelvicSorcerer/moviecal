# Backlog (agent-friendly tasks)

1. Scaffold Next.js app
   - Create Next.js App Router skeleton with TypeScript and Tailwind.
2. Add CI verify workflow
   - GitHub Actions: lint, vitest, and basic Playwright smoke test job.
3. Add Supabase client setup
   - Provide server and client Supabase helpers; document env vars.
4. Draft database schema
   - Create SQL migration for users, movies, watchlist_items, calendar_tokens, and RLS policies.
5. Add auth
   - Wire Supabase auth flows and protect API routes with session checks.
6. Add TMDb search API wrapper
   - Server-side proxy with caching and rate-limit handling.
7. Add movie search page
   - UI to search and view search results; add-to-watchlist button.
8. Add watchlist database operations
   - Implement add/remove and list operations with RLS enforced.
9. Add watchlist page
   - UI to display user's watchlist and release dates.
10. Add calendar token model
    - DB model and UI to create/rotate token.
11. Add `.ics` feed generator
    - iCal generator utilities that produce valid .ics text from watchlist rows.
12. Add calendar feed endpoint
    - Public endpoint that serves .ics for a calendar token.
13. Add scheduled refresh endpoint
    - Protected endpoint to refresh release dates for cached movies.
14. Add Vercel Cron config
    - Configure scheduled call to refresh endpoint.
15. Add tests
    - Unit and E2E tests covering the above features.
16. Add deployment documentation
    - Finalize deployment steps and environment variable documentation.
