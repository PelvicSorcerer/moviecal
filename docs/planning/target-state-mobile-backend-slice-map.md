# Target-state mobile backend slice map

Status: forward-looking architecture map for future planning only.

## How to use this document (important)

- This file is a strategy artifact for future slicing and issue creation.
- It is **not** the active implementation queue and must not override live GitHub issue state.
- Agents should continue to start from the single open issue whose `moviecal Delivery` project item has `Agent Dispatch = Yes` and `Status = Ready`.
- When this map conflicts with active queue scope, GitHub Project and issue state win.

## Scope and intent

This map captures a target backend shape for a mobile-first product direction while preserving current security boundaries (RLS isolation, server-only secrets, unguessable tokens, deterministic calendar UIDs). It translates the current backend into migration slices that can later become GitHub issues or project items.

## Current-state module snapshot

- API handlers are primarily in `src/app/api/**`.
- Core watchlist domain logic is centralized in `src/lib/watchlist.ts`.
- Supabase repository access is centralized in `src/lib/supabase/watchlist.ts`.
- Calendar token and feed logic spans `src/lib/calendar-tokens.ts`, `src/lib/calendar-feed.ts`, and `src/app/api/calendar/[token]/route.ts`.
- Release refresh orchestration is in `src/lib/release-refresh.ts` and `src/app/api/cron/refresh-releases/route.ts`.
- Auth/session helpers are in `src/lib/auth/**`.

## Target-state slice map

| Slice | Current modules | Target direction | Keep / split / replace first |
| --- | --- | --- | --- |
| Auth + identity boundary | `src/lib/auth/session.ts`, auth routes, middleware | Stable identity/session boundary reusable by web + mobile clients | **Keep**, then split request/session adapters from cookie transport concerns |
| Watchlist domain service | `src/lib/watchlist.ts` | Smaller service modules by capability: access, items, memberships, invites | **Split first** (domain logic stays, file/module boundaries improve) |
| Watchlist data access | `src/lib/supabase/watchlist.ts` | Repository packages by aggregate (`watchlists`, `items`, `memberships`, `invites`) with shared row mappers | **Split first** (preserve behavior and RLS assumptions) |
| Calendar token service | `src/lib/calendar-tokens.ts`, `src/lib/supabase/calendar-tokens.ts` | Dedicated token lifecycle service (issue, rotate, resolve owner) with explicit security invariants | **Keep**, then split interface from persistence adapter |
| Calendar feed assembly | `src/lib/calendar-feed.ts`, calendar API route | Feed builder isolated from transport; support personal + shared watchlist composition | **Keep**, then extend for multi-watchlist composition |
| Release refresh workflow | `src/lib/release-refresh.ts`, cron route | Explicit refresh pipeline (selection, TMDb fetch, persistence, reporting) with clear failure surfaces | **Split first** into pipeline stages before adding new schedulers |
| TMDb integration boundary | `src/lib/tmdb/client.ts`, search route | Stable provider interface with strict normalization and retry/error policy | **Keep**, then add provider abstraction only when a second source is needed |
| API transport layer | `src/app/api/**` routes | Thin route handlers: auth, validation, domain call, response mapping | **Keep**, progressively remove duplicated error/validation wrappers |
| Mobile-oriented backend API contract | Existing web route shapes | Versioned API contract that supports mobile clients without exposing service-role secrets | **Replace gradually** via additive endpoints and compatibility period |

## Suggested issue slices (future conversion)

1. Split `watchlist.ts` into capability modules without behavior changes.
2. Split Supabase watchlist repository by aggregate and keep parity tests.
3. Introduce shared error/response mapping helpers for API routes.
4. Extract release-refresh pipeline stages and structured result reporting.
5. Create an executable auth-contract slice that separates identity/session resolution from cookie transport and route-level cookie mutation.
6. Add a versioned mobile API surface for watchlist read/write once the auth-contract slice is in place.

Shared-watchlist calendar aggregation is already the active delivery issue as #74 in the `moviecal Delivery` project and should be tracked there rather than duplicated as future slice work in this file.

## Guardrails for backlog safety

- Do not change current dispatch or queue ordering from this file alone.
- Any slice here should become executable only after a scoped GitHub issue exists with acceptance criteria and verification steps.
- Keep this map in sync with docs only after issue queue decisions are made in GitHub.
