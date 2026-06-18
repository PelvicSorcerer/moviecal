# Backlog plan

This document describes the intended MVP work in dependency order. It is not a progress tracker. Verify current GitHub issue state before starting work because labels, milestones, and issue bodies may change.

## 1) CI verify workflow cleanup

- **Goal**: Ensure the baseline CI workflow matches the local `npm run verify` contract.
- **Requirements**:
  - Pull requests run lint, typecheck, unit tests, and build.
  - E2E tests remain a focused follow-up until feature flows and deterministic mocks exist.
  - CI uses a Node version compatible with the current Next.js dependency.
- **Acceptance criteria**:
  - Workflow is triggered on pull requests.
  - Baseline checks pass without production secrets.
- **Verification**: `npm run verify`

## 2) Supabase environment and client setup

- **Goal**: Add typed Supabase client initialization for browser and server usage.
- **Relevant docs**: `docs/technical/auth-and-security.md`, `docs/technical/architecture.md`, `.env.example`
- **Requirements**:
  - Validate required Supabase environment variables.
  - Create client-safe and server-only helpers.
  - Keep service-role values out of client bundles.
- **Acceptance criteria**:
  - App can instantiate Supabase clients in server and client contexts.
  - Missing env values fail clearly in server contexts.
- **Verification**: `npm run typecheck && npm run test`

## 3) Database schema and RLS

- **Goal**: Create initial Supabase SQL schema and Row Level Security policies.
- **Relevant docs**: `docs/technical/data-model.md`, `docs/technical/auth-and-security.md`
- **Requirements**:
  - Define `movies`, `watchlist_items`, and `calendar_tokens` tables.
  - Add indexes and uniqueness constraints from the data model.
  - Add RLS policies for per-user isolation.
- **Acceptance criteria**:
  - Migration applies cleanly to a local Supabase project.
  - RLS policy intent is documented in migration comments.
- **Verification**: Supabase SQL verification command plus `npm run test`

## 4) Authentication foundation

- **Goal**: Implement Supabase session handling and protected app areas.
- **Relevant docs**: `docs/product/requirements.md`, `docs/technical/auth-and-security.md`
- **Requirements**:
  - Add sign-in and sign-out flow.
  - Protect watchlist and settings pages.
  - Reject unauthenticated requests to user-scoped API endpoints.
- **Acceptance criteria**:
  - User can sign in and sign out.
  - Protected pages and endpoints enforce authentication.
- **Verification**: `npm run test && npm run build`

## 5) TMDb API wrapper

- **Goal**: Add server-side TMDb search and movie-detail helpers.
- **Relevant docs**: `docs/technical/tmdb-integration.md`, `docs/technical/api-design.md`
- **Requirements**:
  - Keep TMDb credentials server-side only.
  - Normalize fields required by the app.
  - Handle TMDb errors without leaking secrets.
- **Acceptance criteria**:
  - Search and detail helpers return typed normalized data.
  - Tests cover success and error cases with mocked TMDb responses.
- **Verification**: `npm run test`

## 6) Movie search UI

- **Goal**: Build the `/search` page and wire it to the server-side movie search endpoint.
- **Relevant docs**: `docs/design/page-map.md`, `docs/design/ui-principles.md`
- **Requirements**:
  - Add search input, loading state, result cards, empty state, and error state.
  - Provide an affordance for adding movies to the watchlist.
- **Acceptance criteria**:
  - Query results display title and release-date information when available.
  - UI does not expose TMDb credentials.
- **Verification**: `npm run test && npm run build`

## 7) Watchlist persistence and UI

- **Goal**: Implement authenticated watchlist list/add/remove operations and a functional `/watchlist` page.
- **Relevant docs**: `docs/technical/api-design.md`, `docs/technical/data-model.md`, `docs/design/page-map.md`
- **Requirements**:
  - Implement `GET /api/watchlist`, `POST /api/watchlist`, and `DELETE /api/watchlist/[id]`.
  - Enforce ownership in server logic and via RLS.
  - Prevent duplicate watchlist entries.
  - Render saved movies and remove actions in the UI.
- **Acceptance criteria**:
  - Authenticated users can manage only their own watchlist items.
  - Duplicate add attempts are safe and deterministic.
- **Verification**: `npm run test && npm run build`

## 8) Calendar token model and settings UI

- **Goal**: Create one active unguessable calendar token per user and expose rotation in settings.
- **Relevant docs**: `docs/technical/calendar-feed-design.md`, `docs/technical/auth-and-security.md`
- **Requirements**:
  - Generate cryptographically random tokens.
  - Store token ownership server-side.
  - Rotation invalidates the previous token.
- **Acceptance criteria**:
  - User can view and rotate a private subscription URL.
  - Old token no longer resolves after rotation.
- **Verification**: `npm run test && npm run build`

## 9) iCalendar generator and feed endpoint

- **Goal**: Generate a valid private `text/calendar` feed for a tokenized watchlist URL.
- **Relevant docs**: `docs/technical/calendar-feed-design.md`, `docs/technical/api-design.md`
- **Requirements**:
  - Return one all-day `VEVENT` per watchlisted movie with a known release date.
  - Use deterministic UIDs that survive token rotation.
  - Return `404` for invalid tokens.
  - Skip movies without release dates for MVP.
- **Acceptance criteria**:
  - iOS Calendar can subscribe to the generated URL.
  - Feed only contains the token owner's watchlist events.
- **Verification**: `npm run test && npm run build`

## 10) Scheduled release-date refresh

- **Goal**: Refresh cached release dates for tracked movies on a schedule.
- **Relevant docs**: `docs/technical/tmdb-integration.md`, `docs/technical/deployment-plan.md`, `docs/technical/auth-and-security.md`
- **Requirements**:
  - Add a protected refresh endpoint.
  - Configure Vercel Cron to call it.
  - Update cached movie release dates and metadata timestamps.
- **Acceptance criteria**:
  - Authorized scheduler calls refresh cached data.
  - Unauthorized requests are rejected.
- **Verification**: `npm run test && npm run build`

## 11) Deployment documentation and hardening

- **Goal**: Provide practical deployment instructions and close any remaining deployment-hardening gaps.
- **Relevant docs**: `docs/technical/deployment-plan.md`, `docs/technical/testing-strategy.md`
- **Requirements**:
  - Document Vercel and Supabase setup.
  - Add security and observability notes for calendar and cron endpoints.
- **Acceptance criteria**:
  - A maintainer can deploy without committing secrets.
- **Verification**: `npm run verify` plus documented E2E command when E2E flows exist.
