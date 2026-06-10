Agents MUST verify GitHub issue state before drafting work. Run `gh issue view <number> --repo PelvicSorcerer/moviecal --json state` and prefer OPEN issues. If an issue is closed, update this file or create a docs PR to reconcile.

# Backlog (agent-ready)

## Completed

## 1) Scaffold Next.js app
- Completed via PR #23 merged on 2026-05-30T04:13:37Z by @PelvicSorcerer.

- **Goal**: Create a minimal Next.js App Router app with TypeScript strict mode and Tailwind.
- **Relevant docs to read**: `README.md`, `docs/technical/tech-stack.md`, `docs/technical/architecture.md`
- **Requirements**:
  - Initialize Next.js App Router project in repo root.
  - Enable TypeScript strict mode.
  - Configure Tailwind CSS.
  - Keep initial pages minimal (`/`, basic layout).
- **Out of scope**: Product feature implementation, Supabase integration, TMDb integration.
- **Acceptance criteria**:
  - Project installs and runs locally.
  - `npm run build` succeeds.
- **Verification command**: `npm run build`

## 2) Add CI verify workflow
- **Goal**: Add GitHub Actions verify workflow for lint/typecheck/test/build.
- **Relevant docs to read**: `docs/technical/testing-strategy.md`, `docs/technical/tech-stack.md`
- **Requirements**:
  - Add workflow triggered on pull requests.
  - Include lint, typecheck, unit tests, and build jobs.
  - Keep workflow compatible with default Node LTS.
- **Out of scope**: New test frameworks beyond planned stack.
- **Acceptance criteria**:
  - Workflow file exists and runs on PR.
  - All configured jobs pass on baseline branch.
- **Verification command**: `gh workflow view` (manual CI run verification in GitHub)

## 3) Add Supabase client setup
- **Goal**: Add typed Supabase client initialization for browser/server usage.
- **Relevant docs to read**: `docs/technical/auth-and-security.md`, `docs/technical/architecture.md`
- **Requirements**:
  - Add env-variable validation for required Supabase values.
  - Create client-safe and server-only helper modules.
  - Document expected env variables.
- **Out of scope**: Full auth flows, DB migration creation.
- **Acceptance criteria**:
  - App can instantiate Supabase clients in server/client contexts.
  - No service-role key exposure in client bundle.
- **Verification command**: `npm run typecheck`

## 4) Draft database schema
- **Goal**: Create initial Supabase SQL schema and RLS policies.
- **Relevant docs to read**: `docs/technical/data-model.md`, `docs/technical/auth-and-security.md`
- **Requirements**:
  - Define `movies`, `watchlist_items`, and `calendar_tokens` tables.
  - Add indexes and uniqueness constraints per docs.
  - Add RLS policies enforcing per-user watchlist isolation.
- **Out of scope**: UI pages, TMDb API code.
- **Acceptance criteria**:
  - SQL migration applies cleanly.
  - RLS policy intent documented in migration comments.
- **Verification command**: `supabase db lint` (or project SQL verification command)

## 5) Add auth
- **Goal**: Implement authentication foundation with Supabase session handling.
- **Relevant docs to read**: `docs/product/requirements.md`, `docs/technical/auth-and-security.md`
- **Requirements**:
  - Add sign-in page/flow.
  - Ensure protected routes require authenticated session.
  - Ensure authenticated API endpoints reject unauthenticated requests.
- **Out of scope**: Advanced profile management.
- **Acceptance criteria**:
  - User can sign in and sign out.
  - Protected pages/routes enforce auth.
- **Verification command**: `npm run test`

## 6) Add TMDb search API wrapper
- **Goal**: Add server-side TMDb wrapper for movie search and details.
- **Relevant docs to read**: `docs/technical/tmdb-integration.md`, `docs/technical/api-design.md`
- **Requirements**:
  - Implement search and movie detail fetch helpers.
  - Keep TMDb API key server-side only.
  - Add input validation and error handling.
- **Out of scope**: Search page UI.
- **Acceptance criteria**:
  - Wrapper returns normalized fields required by app.
  - Handles TMDb errors without leaking secrets.
- **Verification command**: `npm run test`

## 7) Add movie search page
- **Goal**: Build `/search` page to query TMDb and display results.
- **Relevant docs to read**: `docs/design/page-map.md`, `docs/design/ui-principles.md`
- **Requirements**:
  - Add search input and results list UI.
  - Connect to server-side TMDb search endpoint.
  - Provide action affordance for adding to watchlist.
- **Out of scope**: Final watchlist persistence logic.
- **Acceptance criteria**:
  - Query returns visible results with title and release date.
  - Empty/error states are handled.
- **Verification command**: `npm run test:e2e`

## 8) Add watchlist database operations
- **Goal**: Implement authenticated watchlist add/remove/list operations.
- **Relevant docs to read**: `docs/technical/api-design.md`, `docs/technical/data-model.md`
- **Requirements**:
  - Add `GET/POST /api/watchlist` and `DELETE /api/watchlist/[id]`.
  - Enforce user ownership checks in server logic and via RLS.
  - Prevent duplicate watchlist entries.
- **Out of scope**: Watchlist UI polishing.
- **Acceptance criteria**:
  - Authenticated user can add/remove/list own items only.
  - Duplicate add attempts are safely handled.
- **Verification command**: `npm run test`

## 9) Add watchlist page
- **Goal**: Create `/watchlist` UI for viewing and removing saved movies.
- **Relevant docs to read**: `docs/design/page-map.md`, `docs/product/user-stories.md`
- **Requirements**:
  - Render current user watchlist.
  - Show known release dates.
  - Add remove action for entries.
- **Out of scope**: Calendar feed generation.
- **Acceptance criteria**:
  - Page lists current user movies only.
  - Remove action updates view and data.
- **Verification command**: `npm run test:e2e`

## 10) Add calendar token model
- **Goal**: Support per-user private calendar token issuance and rotation.
- **Relevant docs to read**: `docs/technical/calendar-feed-design.md`, `docs/technical/auth-and-security.md`
- **Requirements**:
  - Ensure each user maps to exactly one active token.
  - Generate cryptographically random, unguessable tokens.
  - Add rotate-token operation that invalidates prior token.
- **Out of scope**: `.ics` serialization logic.
- **Acceptance criteria**:
  - User can retrieve and rotate private token.
  - Old token no longer resolves feed after rotation.
- **Verification command**: `npm run test`

## 11) Add `.ics` feed generator
- **Goal**: Generate valid iCalendar output from watchlist release data.
- **Relevant docs to read**: `docs/technical/calendar-feed-design.md`, `docs/product/requirements.md`
- **Requirements**:
  - Emit `text/calendar`-compatible content.
  - Emit one all-day VEVENT per movie with known release date.
  - Generate deterministic stable UIDs.
  - Skip movies with unknown release dates for MVP.
- **Out of scope**: Public token endpoint routing.
- **Acceptance criteria**:
  - Generated feed validates as `.ics`.
  - Re-generating same input keeps UIDs stable.
- **Verification command**: `npm run test`

## 12) Add calendar feed endpoint
- **Goal**: Expose public tokenized feed endpoint `/api/calendar/[token].ics`.
- **Relevant docs to read**: `docs/technical/api-design.md`, `docs/technical/calendar-feed-design.md`
- **Requirements**:
  - Resolve token to exactly one user.
  - Return `200` with `Content-Type: text/calendar` for valid token.
  - Return `404` for invalid token.
  - Do not require interactive login.
- **Out of scope**: Token rotation UI.
- **Acceptance criteria**:
  - iOS Calendar can subscribe using generated URL.
  - Endpoint only returns requesting token owner’s watchlist events.
- **Verification command**: `npm run test:e2e`

## 13) Add scheduled refresh endpoint
- **Goal**: Add protected endpoint to refresh cached release dates.
- **Relevant docs to read**: `docs/technical/tmdb-integration.md`, `docs/technical/api-design.md`
- **Requirements**:
  - Implement server-only refresh process for tracked movies.
  - Protect endpoint with scheduler secret/auth.
  - Update cached release dates and metadata timestamps.
- **Out of scope**: Cron provider configuration.
- **Acceptance criteria**:
  - Authorized trigger refreshes cached movie data.
  - Unauthorized requests are rejected.
- **Verification command**: `npm run test`

## 14) Add Vercel Cron config
- **Goal**: Configure scheduled calls to refresh endpoint in Vercel.
- **Relevant docs to read**: `docs/technical/deployment-plan.md`, `docs/technical/auth-and-security.md`
- **Requirements**:
  - Add cron schedule configuration file/settings.
  - Ensure secret header/token configuration is documented.
- **Out of scope**: Refresh endpoint implementation changes.
- **Acceptance criteria**:
  - Cron schedule exists and targets refresh route.
  - Security mechanism for cron invocation is documented.
- **Verification command**: `vercel --prod` (or dashboard verification of cron schedule)

## 15) Add tests
- **Goal**: Add unit and E2E test coverage for core MVP flows.
- **Relevant docs to read**: `docs/technical/testing-strategy.md`, `docs/product/user-stories.md`
- **Requirements**:
  - Add unit tests for UID generation and ICS formatting.
  - Add integration/E2E tests for auth, search, watchlist, and feed endpoint.
  - Keep tests deterministic using stubs/mocks for TMDb.
- **Out of scope**: Non-MVP feature testing.
- **Acceptance criteria**:
  - Critical flows covered in CI.
  - Failing regressions are reproducible via local commands.
- **Verification command**: `npm run test && npm run test:e2e`

## 16) Add deployment documentation
- **Goal**: Finalize practical deployment documentation for Vercel + Supabase.
- **Relevant docs to read**: `docs/technical/deployment-plan.md`, `README.md`
- **Requirements**:
  - Document required env vars and where to set them.
  - Document deployment steps and post-deploy checks.
  - Include security reminders for public repo.
- **Out of scope**: Infra automation beyond documented manual steps.
- **Acceptance criteria**:
  - New contributor can follow docs to deploy safely.
  - Docs explicitly avoid committing secrets.
- **Verification command**: `npm run build`
