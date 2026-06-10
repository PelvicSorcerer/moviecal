# Implementation plan

This document describes the intended implementation order after the scaffold baseline. It is an execution plan, not a historical progress tracker.

## Phase 0: Repo/docs preparation

- **Goal**: Finalize planning docs and create agent-ready execution artifacts.
- **Deliverables**:
  - Documentation audit
  - Agent-ready backlog items
  - Phase-based implementation guide
  - GitHub labels/milestones/issues (or manual fallback file)
- **Dependencies**: Existing planning and technical docs
- **Suggested GitHub issues**:
  - Prepare planning docs and issue templates from backlog
- **Definition of done**:
  - Docs are internally consistent and actionable for cloud agents
  - First implementation sequence is broken into issue-sized tasks

## Phase 1: App scaffold

- **Goal**: Establish a clean Next.js baseline with strict TypeScript and Tailwind.
- **Deliverables**:
  - Next.js App Router scaffold
  - TypeScript strict mode configured
  - Tailwind configured
  - Basic app routes/shell committed
- **Dependencies**: Phase 0 complete
- **Suggested GitHub issues**:
  - Scaffold Next.js app
  - Add CI verify workflow
- **Definition of done**:
  - App builds locally
  - CI verify runs on pull requests and default-branch pushes

## Phase 2: Auth and database foundation

- **Goal**: Prepare Supabase integration and initial data model with security boundaries.
- **Deliverables**:
  - Supabase env + client setup (server/client)
  - Database schema draft/migrations for movies/watchlist/tokens
  - RLS policies for per-user access
  - Authentication foundation
- **Dependencies**: Phase 1 scaffold
- **Suggested GitHub issues**:
  - Add Supabase environment and client setup
  - Draft Supabase database schema
  - Add authentication foundation
- **Definition of done**:
  - Authenticated user identity is available in app/API routes
  - Schema and RLS policies are reviewed and versioned

## Phase 3: TMDb movie search

- **Goal**: Provide reliable server-side TMDb integration and user search UX.
- **Deliverables**:
  - TMDb API wrapper/proxy
  - Query validation/error handling
  - Movie search page with results
- **Dependencies**: Phase 2 auth/database baseline
- **Suggested GitHub issues**:
  - Add TMDb API wrapper
  - Add movie search page
- **Definition of done**:
  - Authenticated user can search TMDb via app UI
  - API wrapper keeps key server-side

## Phase 4: Watchlist MVP

- **Goal**: Allow users to persist and manage personal watchlists.
- **Deliverables**:
  - Watchlist DB operations (add/remove/list)
  - Watchlist page UI
  - Per-user access controls enforced via RLS
- **Dependencies**: Phase 3 TMDb integration
- **Suggested GitHub issues**:
  - Add watchlist database operations
  - Add watchlist page
- **Definition of done**:
  - User can add/remove movies and see only own watchlist

## Phase 5: Calendar feed MVP

- **Goal**: Provide private, tokenized iCalendar feed for watchlisted movie releases.
- **Deliverables**:
  - Calendar token model
  - `.ics` feed generator
  - Public feed endpoint returning `text/calendar`
- **Dependencies**: Phase 4 watchlist functionality
- **Suggested GitHub issues**:
  - Add calendar token model
  - Add iCalendar feed generator
  - Add calendar feed endpoint
- **Definition of done**:
  - Valid token returns `.ics` feed with all-day events and stable UIDs
  - Invalid token returns `404`
  - Movies with unknown release dates are omitted in MVP

## Phase 6: Release-date refresh

- **Goal**: Keep feed data current as TMDb release dates change.
- **Deliverables**:
  - Protected scheduled refresh endpoint
  - Vercel Cron configuration
- **Dependencies**: Phase 5 feed endpoint
- **Suggested GitHub issues**:
  - Add scheduled release-date refresh endpoint
  - Add Vercel Cron configuration
- **Definition of done**:
  - Scheduled job can trigger refresh securely
  - Updated release dates are reflected in subsequent feed responses

## Phase 7: Deployment

- **Goal**: Document and execute production deployment on Vercel + Supabase.
- **Deliverables**:
  - Deployment runbook with required environment variables
  - Environment-specific validation checklist
- **Dependencies**: Phases 1-6
- **Suggested GitHub issues**:
  - Add deployment documentation
- **Definition of done**:
  - Deployable configuration is documented and reproducible

## Phase 8: Hardening and polish

- **Goal**: Improve reliability, security, and maintainability before broader use.
- **Deliverables**:
  - Unit/integration/E2E tests for critical flows
  - Additional error handling and observability notes
  - Security review checklist
- **Dependencies**: Phases 1-7
- **Suggested GitHub issues**:
  - Add tests
  - Harden calendar/auth error paths
- **Definition of done**:
  - Core flows are covered by automated tests
  - Security and operational risks are explicitly documented
