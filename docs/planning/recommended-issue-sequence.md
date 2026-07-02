# Recommended issue sequence

Start with cleanup that makes the scaffold consistent, then follow the dependency chain below. GitHub issue numbers are intentionally omitted here because issue state can change; verify current open issues before starting work.

1. Normalize README, env template, route naming docs, and CI baseline.
2. Reconcile overlapping CI/testing issues:
   - Keep one CI baseline task for lint, typecheck, unit tests, and build on pull requests.
   - Keep E2E CI integration as a later task once auth/search/watchlist/feed flows have deterministic mocks.
3. Add Supabase environment validation and client/server helper modules.
4. Draft Supabase schema and RLS migrations.
5. Add authentication foundation and protected routes.
6. Add server-side TMDb wrapper for search and details.
7. Build the `/search` page against the server-side movie search endpoint.
8. Implement authenticated watchlist database operations.
9. Build the `/watchlist` page.
10. Add calendar token model and rotation behavior.
11. Add deterministic iCalendar feed generation.
12. Add tokenized calendar feed endpoint.
13. Add protected scheduled release-date refresh endpoint.
14. Add Vercel Cron configuration.
15. Finalize deployment documentation.
16. Add unit tests for core utilities and iCalendar formatting.
17. Add integration tests for Supabase client and TMDb wrapper.
18. Add Playwright smoke tests for the main user flows.
19. Align the CI verify workflow with the focused test contract after those test tasks land.

## Current open issue queue

The current live queue lives in the `moviecal Delivery` GitHub Project. Use project `Queue Order` for ordering and the single open issue with `Agent Dispatch = Yes` plus `Status = Ready` for dispatch. `npm run agent:check` and `npm run agent:handoff` validate that invariant directly from project state. If other tooling still needs `docs/planning/open-issue-order.json`, regenerate it with `bash scripts/export-open-issue-order.sh`; do not hand-edit it.

## Agent handoff notes

- Do not skip the Supabase/auth foundation before implementing persistent watchlist behavior.
- Keep TMDb credentials server-side only.
- Calendar token work and feed generation should be separate tasks so token rotation can be tested independently from `.ics` formatting.
- Run `npm run verify` for baseline checks. Add focused E2E commands only when the related flows exist and can run deterministically without production secrets.
