# Shared test data foundation

Deterministic fixtures and factories for unit, integration, and browser tests.

## Source of truth

| Layer | Location | Purpose |
|---|---|---|
| Canonical catalog | `src/lib/test-data/catalog.ts` | Fixed IDs, timestamps, and movie payloads shared by Vitest and E2E runtime fixtures |
| Factories | `test/support/factories/` | Builders for domain objects (users, movies, watchlists, memberships, calendar rows) |
| Repository mocks | `test/support/mocks/` | Default no-op `WatchlistRepository` and `CalendarTokenRepository` implementations |
| E2E runtime | `src/lib/e2e/fixtures.ts` | Cookie-backed Playwright seeding (imports the canonical catalog) |
| Playwright wiring | `e2e/test-fixtures.ts` | `test.extend()` helpers that compose E2E runtime fixtures |

Import shared builders from `test/support` in Vitest tests:

```ts
import {
  buildWatchlistItem,
  buildWatchlistSummary,
  buildTmdbSearchResponse,
  createWatchlistRepository,
} from './support';
```

Import the catalog directly when you only need constants:

```ts
import { TEST_TMDB_IDS, TEST_USER_IDS } from '../src/lib/test-data/catalog';
```

## Isolation rules

1. **No production data** — use catalog IDs, disposable emails (`*@moviecal.test`), and fake tokens only.
2. **No live secrets** — never copy real Supabase keys, calendar tokens, or TMDb credentials into fixtures.
3. **Deterministic timestamps** — read from `TEST_TIMESTAMPS`; do not call `Date.now()` or `Math.random()` when tests assert on values.
4. **Override at the edge** — pass `overrides` to factories for scenario-specific fields; do not fork entire builders for one-field changes.
5. **Repository mocks stay partial-friendly** — start from `createWatchlistRepository()` / `createCalendarTokenRepository()` and override only the methods under test.
6. **E2E vs Vitest IDs** — unit/integration tests use `TEST_USER_IDS.OWNER` (`user-1`); browser E2E uses `TEST_USER_IDS.E2E_OWNER` (`e2e-user`). Map explicitly when bridging layers.

## Movie catalog

Registered TMDb IDs live in `TEST_MOVIE_CATALOG`:

- `603` — The Matrix
- `27205` — Inception

Add new movies to `src/lib/test-data/catalog.ts` first, then use `buildWatchlistItem(tmdbId)` or `buildNormalizedMovieDetail(tmdbId)` in tests.

## Related docs

- [Repository testing strategy](../../docs/planning/repository-testing-strategy.md) — capability-to-layer map and mocking policy
- [Testing lanes](../../docs/planning/testing-lanes.md) — `npm run lane:unit`, `lane:integration`, `lane:browser`
