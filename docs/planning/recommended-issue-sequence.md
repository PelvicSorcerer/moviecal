# Recommended issue sequence (first 16 tasks)

This document describes the intended execution order for future work. It is not a historical progress log.

Start with the scaffold, then follow the dependency chain below. Where an issue number is indicated, that refers to the existing GitHub issue.

1. Scaffold Next.js app (issue #6)
2. Add CI verify workflow (issue #8)
3. Add Supabase client setup (issue #3)
4. Draft Supabase database schema (issue #10)
5. Add authentication foundation (issue #7)
6. Add TMDb API wrapper (issue #11)
7. Add movie search page (issue #9)
8. Add watchlist database operations (issue #16)
9. Add watchlist page (issue #13)
10. Add calendar token model (issue #2)
11. Add iCalendar feed generator (issue #4)
12. Add calendar feed endpoint (issue #5)
13. Add scheduled release-date refresh endpoint (issue #12)
14. Add Vercel Cron configuration (issue #17)
15. Add deployment documentation (issue #15)
16. Add tests (split into focused sub-issues; base issue #14)

Notes
- The listed order assumes standard dependency flow: scaffold → infra/CI → auth/db → integrations → feature UIs → calendar feed → deployment/tests.
- Adjust ordering if a particular task needs priority or the docs suggest a different dependency chain.

Verification
- With the scaffold in place, run `npm run verify` before starting the next issue-sized PRs.
