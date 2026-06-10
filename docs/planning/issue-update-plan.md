# Issue update plan (manual fallback)

Context
- GitHub CLI was available and authenticated in this environment, so many edits were applied directly.
- This file is a fallback and records recommended edits for manual application if required.

For each open issue (numbered):

- #6 Scaffold Next.js app
  - Keep. Updated body to include full scaffold checklist and acceptance criteria. Labels: scaffold. Milestone: Phase 1 - Scaffold.

- #7 Add authentication foundation
  - Keep. Labels: auth. Milestone: Phase 2 - Auth and Database.

- #8 Add CI verify workflow
  - Keep but mark post-scaffold; Labels: tests. Milestone: Phase 1 - Scaffold.

- #9 Add movie search page
  - Keep; Labels: tmdb. Milestone: Phase 3 - Search and Watchlist.

- #10 Draft Supabase database schema
  - Keep; Labels: database. Milestone: Phase 2 - Auth and Database.

- #11 Add TMDb API wrapper
  - Keep; Labels: tmdb. Milestone: Phase 3 - Search and Watchlist.

- #12 Add scheduled release-date refresh endpoint
  - Keep; Labels: calendar,deployment. Milestone: Phase 5 - Refresh and Deployment.

- #13 Add watchlist page
  - Keep; Labels: watchlist. Milestone: Phase 3 - Search and Watchlist.

- #14 Add tests
  - Split: create sub-issues for unit tests, integration tests, E2E tests, and CI test integration. Label base issue: tests, post-scaffold. Milestone: Phase 1 - Scaffold.

- #15 Add deployment documentation
  - Keep; Labels: docs, deployment. Milestone: Phase 0 - Planning.

- #16 Add watchlist database operations
  - Keep; Labels: database, watchlist. Milestone: Phase 3 - Search and Watchlist.

- #17 Add Vercel Cron configuration
  - Keep; Labels: deployment, post-scaffold. Milestone: Phase 5 - Refresh and Deployment.

Actions taken by agent
- Created docs/planning/issues-audit.md
- Created docs/planning/recommended-issue-sequence.md
- Created labels: blocked, post-scaffold
- Created milestone: Phase 0 - Planning
- Applied labels and milestones to open issues
- Updated issue #6 body to scaffold checklist
- Reconciled docs/planning/backlog.md to mark #6 completed via PR #23.

If GitHub editing is restricted, use the above mappings to update issues manually via the web UI or a local gh login.
