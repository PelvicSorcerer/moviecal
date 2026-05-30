# Proposed GitHub labels, milestones, and issues (manual fallback)

`gh auth status` currently reports an invalid token in this environment, so labels/milestones/issues were not created automatically.

## Labels to create (manual)

```bash
gh label create scaffold --color "0E8A16" --description "Scaffolding and project bootstrap"
gh label create docs --color "1D76DB" --description "Documentation changes"
gh label create auth --color "5319E7" --description "Authentication and authorization"
gh label create database --color "0052CC" --description "Database schema and data layer"
gh label create tmdb --color "B60205" --description "TMDb integration"
gh label create watchlist --color "FBCA04" --description "Watchlist feature"
gh label create calendar --color "C2E0C6" --description "iCalendar feed and token work"
gh label create tests --color "D4C5F9" --description "Testing and quality gates"
gh label create deployment --color "006B75" --description "Deployment and hosting"
gh label create security --color "B60205" --description "Security hardening"
gh label create agent-ready --color "5319E7" --description "Task is scoped for a single agent PR"
gh label create needs-review --color "E99695" --description "Needs human review"
```

## Milestones to create (manual)

```bash
gh api repos/PelvicSorcerer/moviecal/milestones -f title="Phase 1 - Scaffold"
gh api repos/PelvicSorcerer/moviecal/milestones -f title="Phase 2 - Auth and Database"
gh api repos/PelvicSorcerer/moviecal/milestones -f title="Phase 3 - Search and Watchlist"
gh api repos/PelvicSorcerer/moviecal/milestones -f title="Phase 4 - Calendar Feed"
gh api repos/PelvicSorcerer/moviecal/milestones -f title="Phase 5 - Refresh and Deployment"
gh api repos/PelvicSorcerer/moviecal/milestones -f title="Phase 6 - Hardening"
```

## Proposed issues

---

### 1) Scaffold Next.js app

**Goal**
Create a minimal Next.js App Router app with TypeScript strict mode and Tailwind.

**Context**
The repository is currently planning/docs only. We need a clean scaffold before feature work.

**Requirements**
- Initialize Next.js App Router project in repo root.
- Enable TypeScript strict mode.
- Configure Tailwind CSS.
- Keep initial pages minimal (`/`, basic layout).

**Out of scope**
- Product feature implementation.
- Supabase/TMDb integrations.

**Acceptance criteria**
- Project installs and runs locally.
- `npm run build` succeeds.

**Relevant docs/files to read**
- `README.md`
- `docs/technical/tech-stack.md`
- `docs/technical/architecture.md`

**Verification command**
- `npm run build`

---

### 2) Add CI verify workflow

**Goal**
Add GitHub Actions verify workflow for lint/typecheck/test/build.

**Context**
CI is required before expanding implementation tasks.

**Requirements**
- Add workflow triggered on pull requests.
- Include lint, typecheck, unit tests, and build jobs.
- Use Node LTS.

**Out of scope**
- Additional frameworks beyond planned stack.

**Acceptance criteria**
- Workflow file exists and runs on PR.
- Baseline branch passes all verify jobs.

**Relevant docs/files to read**
- `docs/technical/testing-strategy.md`
- `docs/technical/tech-stack.md`

**Verification command**
- `gh workflow view`

---

### 3) Add Supabase environment and client setup

**Goal**
Add typed Supabase client initialization for browser and server.

**Context**
Auth/data work depends on a secure and consistent Supabase setup.

**Requirements**
- Add env validation for required Supabase values.
- Create client-safe and server-only helper modules.
- Document required env variables.

**Out of scope**
- Full auth flow.
- Schema migrations.

**Acceptance criteria**
- Clients can be instantiated in server and client contexts.
- Service-role key is never used client-side.

**Relevant docs/files to read**
- `docs/technical/auth-and-security.md`
- `docs/technical/architecture.md`

**Verification command**
- `npm run typecheck`

---

### 4) Draft Supabase database schema

**Goal**
Create initial SQL schema and RLS policies.

**Context**
Watchlist and calendar feed depend on reliable DB foundations.

**Requirements**
- Define `movies`, `watchlist_items`, `calendar_tokens`.
- Add indexes and uniqueness constraints.
- Add RLS policies for per-user watchlist isolation.

**Out of scope**
- UI pages.

**Acceptance criteria**
- Migration applies cleanly.
- RLS policy intent is documented.

**Relevant docs/files to read**
- `docs/technical/data-model.md`
- `docs/technical/auth-and-security.md`

**Verification command**
- `supabase db lint`

---

### 5) Add authentication foundation

**Goal**
Implement sign-in/session foundation.

**Context**
User-private watchlist/feed require authenticated identity.

**Requirements**
- Add sign-in page/flow.
- Protect authenticated pages/routes.
- Reject unauthenticated access on protected API routes.

**Out of scope**
- Advanced account management.

**Acceptance criteria**
- User can sign in and sign out.
- Protected routes enforce auth checks.

**Relevant docs/files to read**
- `docs/product/requirements.md`
- `docs/technical/auth-and-security.md`

**Verification command**
- `npm run test`

---

### 6) Add TMDb API wrapper

**Goal**
Add server-side wrapper for TMDb search/detail.

**Context**
Search/watchlist features need TMDb data while keeping keys server-side.

**Requirements**
- Implement search and detail helpers.
- Keep TMDb key server-only.
- Add validation/error handling.

**Out of scope**
- Search UI page.

**Acceptance criteria**
- Wrapper returns normalized fields.
- Error responses do not leak secrets.

**Relevant docs/files to read**
- `docs/technical/tmdb-integration.md`
- `docs/technical/api-design.md`

**Verification command**
- `npm run test`

---

### 7) Add movie search page

**Goal**
Build `/search` page for TMDb query and result display.

**Context**
This is the primary discovery surface for adding watchlist items.

**Requirements**
- Add search input and results UI.
- Connect to server-side TMDb search endpoint.
- Provide add-to-watchlist action affordance.

**Out of scope**
- Final watchlist persistence behavior.

**Acceptance criteria**
- Query shows matching results.
- Empty/error states are handled.

**Relevant docs/files to read**
- `docs/design/page-map.md`
- `docs/design/ui-principles.md`

**Verification command**
- `npm run test:e2e`

---

### 8) Add watchlist database operations

**Goal**
Implement authenticated watchlist add/remove/list API operations.

**Context**
Core watchlist persistence for user data isolation.

**Requirements**
- Add `GET/POST /api/watchlist`.
- Add `DELETE /api/watchlist/[id]`.
- Enforce ownership checks and prevent duplicates.

**Out of scope**
- Watchlist page UI polish.

**Acceptance criteria**
- Users can only manage their own items.
- Duplicate adds are safely handled.

**Relevant docs/files to read**
- `docs/technical/api-design.md`
- `docs/technical/data-model.md`

**Verification command**
- `npm run test`

---

### 9) Add watchlist page

**Goal**
Create `/watchlist` UI for viewing/removing saved movies.

**Context**
Users need a dedicated view to manage tracked movies.

**Requirements**
- Render current user watchlist.
- Show known release dates.
- Provide remove action.

**Out of scope**
- Calendar feed endpoint.

**Acceptance criteria**
- Page shows only current user data.
- Remove action updates list and persistence.

**Relevant docs/files to read**
- `docs/design/page-map.md`
- `docs/product/user-stories.md`

**Verification command**
- `npm run test:e2e`

---

### 10) Add calendar token model

**Goal**
Support per-user private calendar token issue/rotation.

**Context**
Tokenized URL is the auth model for `.ics` feed access.

**Requirements**
- One active token per user.
- Cryptographically random, unguessable token generation.
- Rotation invalidates previous token.

**Out of scope**
- Feed serialization.

**Acceptance criteria**
- User can retrieve and rotate token.
- Old token no longer resolves feed.

**Relevant docs/files to read**
- `docs/technical/calendar-feed-design.md`
- `docs/technical/auth-and-security.md`

**Verification command**
- `npm run test`

---

### 11) Add iCalendar feed generator

**Goal**
Generate valid `.ics` output from watchlist release data.

**Context**
Feed generator is required before public endpoint integration.

**Requirements**
- Emit iCalendar-compatible content.
- Emit one all-day VEVENT per movie with known release date.
- Emit stable deterministic UIDs.
- Skip unknown release dates for MVP.

**Out of scope**
- Public feed route/token lookup.

**Acceptance criteria**
- Generated feed validates as `.ics`.
- UID remains stable for same user/movie data.

**Relevant docs/files to read**
- `docs/technical/calendar-feed-design.md`
- `docs/product/requirements.md`

**Verification command**
- `npm run test`

---

### 12) Add calendar feed endpoint

**Goal**
Expose `/api/calendar/[token].ics` public tokenized endpoint.

**Context**
This endpoint enables iOS Calendar subscription.

**Requirements**
- Resolve token to exactly one user.
- Return `200` + `Content-Type: text/calendar` for valid token.
- Return `404` for invalid token.
- Do not require interactive login.

**Out of scope**
- Token rotation UI work.

**Acceptance criteria**
- iOS Calendar can subscribe using provided URL.
- Endpoint only returns token owner data.

**Relevant docs/files to read**
- `docs/technical/api-design.md`
- `docs/technical/calendar-feed-design.md`

**Verification command**
- `npm run test:e2e`

---

### 13) Add scheduled release-date refresh endpoint

**Goal**
Add protected endpoint to refresh cached TMDb release dates.

**Context**
Watchlist feeds must stay current as release dates change.

**Requirements**
- Implement refresh logic for tracked movies.
- Protect endpoint with scheduler secret/auth.
- Update cached metadata timestamps.

**Out of scope**
- Cron provider configuration.

**Acceptance criteria**
- Authorized trigger updates cached data.
- Unauthorized requests rejected.

**Relevant docs/files to read**
- `docs/technical/tmdb-integration.md`
- `docs/technical/api-design.md`

**Verification command**
- `npm run test`

---

### 14) Add Vercel Cron configuration

**Goal**
Configure Vercel Cron to call refresh endpoint on schedule.

**Context**
Automated refresh is required to keep release dates in sync.

**Requirements**
- Add cron schedule config.
- Document secure invocation mechanism.

**Out of scope**
- Refresh endpoint logic changes.

**Acceptance criteria**
- Cron schedule exists and targets refresh route.
- Secret usage is documented.

**Relevant docs/files to read**
- `docs/technical/deployment-plan.md`
- `docs/technical/auth-and-security.md`

**Verification command**
- `vercel --prod`

---

### 15) Add deployment documentation

**Goal**
Finalize deploy runbook for Vercel + Supabase.

**Context**
Project needs safe, reproducible deployment steps.

**Requirements**
- Document required env vars and placement.
- Document deploy steps and post-deploy checks.
- Include public-repo security reminders.

**Out of scope**
- Infra automation beyond documentation.

**Acceptance criteria**
- New contributor can follow docs to deploy safely.
- Docs explicitly avoid committing secrets.

**Relevant docs/files to read**
- `docs/technical/deployment-plan.md`
- `README.md`

**Verification command**
- `npm run build`
