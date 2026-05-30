# Issues audit — moviecal

Date: 2026-05-30 UTC

Summary
- Reviewed all existing open issues in the repository (issues 2..17).
- Most feature issues are already well-scoped (Goal, Requirements, Acceptance criteria present).
- Problems found: widespread use of `agent-ready` before scaffold, missing `post-scaffold` usage, one broadly-scoped tests issue, and a small set of verification/acceptance clarifications needed.

Existing issues reviewed
- 2 — Add calendar token model (good)
- 3 — Add Supabase client setup (good)
- 4 — Add iCalendar feed generator (good)
- 5 — Add calendar feed endpoint (good)
- 6 — Scaffold Next.js app (needs extra required checklist; must be the only coding issue marked ready pre-scaffold)
- 7 — Add authentication foundation (good)
- 8 — Add CI verify workflow (post-scaffold)
- 9 — Add movie search page (post-scaffold)
- 10 — Draft Supabase database schema (good)
- 11 — Add TMDb API wrapper (good)
- 12 — Add scheduled release-date refresh endpoint (post-scaffold)
- 13 — Add watchlist page (post-scaffold)
- 14 — Add tests (TOO BROAD — split into smaller tasks)
- 15 — Add deployment documentation (docs-only; can be done in Phase 0 Planning)
- 16 — Add watchlist database operations (post-scaffold)
- 17 — Add Vercel Cron configuration (post-scaffold)

Which issues are good enough for an agent
- 2,3,4,5,7,9,10,11,12,13,16,17 — have clear goals, requirements, acceptance criteria, and verification commands. They only need label/milestone normalization.

Which issues are too broad
- 14 (Add tests): spans unit, integration, E2E and CI. Recommend splitting into:
  - Unit tests for core utils and feed generator
  - Integration tests for Supabase client and TMDb wrapper (mocked)
  - E2E smoke tests for main flows
  - CI integration to run the above

Duplicate issues
- None detected. Keep existing issues; do not create duplicates.

Missing acceptance criteria or verification
- Most issues include acceptance criteria. Suggested clarifications for a few:
  - Tests: add pass/failure thresholds, example test names to cover.
  - CI verify workflow: list exact npm scripts to run (`npm run verify` expected).
  - Deployment: avoid `vercel --prod` as a verification step; prefer a checklist of docs + smoke checks.

Which should be done before app scaffolding
- Docs-only work (Phase 0 Planning): issue 15 (Add deployment documentation) and small planning/docs edits. These can be completed before scaffold but are optional.
- The only coding issue that should be marked `agent-ready` before app scaffolding is the scaffold issue (6).

Which should wait until after app scaffolding
- All coding tasks that touch the application (issues 3,4,5,7,8,9,10,11,12,13,14,16,17) should be `post-scaffold`. Mark them accordingly.

Recommended next steps (short)
1. Update labels: remove `agent-ready` from non-scaffold issues; add `post-scaffold` to code tasks.
2. Ensure milestone mapping (Phase 0..6) is applied to issues.
3. Update issue 6 (Scaffold) to include the full required checklist and `npm run verify` as acceptance.
4. Split issue 14 into smaller testing tasks.
5. Add docs: `docs/planning/recommended-issue-sequence.md` with the ordered list.

References
- docs/planning/proposed-github-issues.md
- README.md

Audit produced by an agentic normalization pass. Do not scaffold the app in this change.
