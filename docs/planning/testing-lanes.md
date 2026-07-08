# Testing lanes

This document is the authoritative map of moviecal's explicit testing lanes. Use it to choose the right command locally, interpret CI job names, and understand what each lane is expected to catch.

For the broader testing policy — capability-to-layer mapping, mock rules, and merge-gate expectations — see [repository-testing-strategy.md](./repository-testing-strategy.md).

For the environment contract behind each lane, including disposable credential rules, seeded-data expectations, and the distinction between deterministic local validation and real-stack CI, see [test-environment-contract.md](./test-environment-contract.md).

## Lane overview

| Lane | Local command | CI workflow / job | Speed | Merge gate |
|---|---|---|---|---|
| Baseline | `npm run lane:baseline` | `verify` → `lane-baseline` | Fast | Yes — default PR gate |
| Unit | `npm run lane:unit` | `verify` → `lane-unit` | Fast | Yes — default PR gate |
| Integration | `npm run lane:integration` | `verify` → `lane-integration` | Fast | Yes — default PR gate |
| Browser | `npm run lane:browser` | `browser-verify` → `lane-browser` | Medium | Yes — default PR gate |
| Browser quarantine | `npm run lane:browser:quarantine` | `browser-verify` → `lane-browser-quarantine` | Medium | No — informational flake tracking |
| Real-stack | `npm run lane:real-stack` | `supabase-verify` → `lane-real-stack` | Heavy | Conditional — path-filtered |
| Full-stack runtime | `npm run lane:full-stack` | `supabase-verify` → `lane-full-stack-runtime` | Heavy | Conditional — path-filtered |
| External smoke | `npm run lane:smoke-external` | `smoke-external` → `lane-smoke-external` | Heavy | No — scheduled/manual (stub until #139) |
| Post-deploy smoke | `npm run lane:smoke-post-deploy` | `smoke-post-deploy` → `lane-smoke-post-deploy` | Heavy | No — post-deploy/scheduled (stub until #140) |

The default fast pull-request gate is `npm run verify`, which runs the **baseline**, **unit**, and **integration** lanes in sequence. Browser, real-stack, and smoke lanes stay separate so failures are attributable to the lane that owns the behavior.

## Lane definitions

### Baseline (`lane:baseline`)

**Purpose:** Catch compile-time, lint, and production-build regressions without running application tests.

**Runs:** `npm run lint`, `npm run typecheck`, `npm run build`

**Expected to catch:**

- TypeScript type errors
- lint violations (when lint is enabled beyond the scaffold placeholder)
- Next.js build or bundling failures

**Not expected to catch:** runtime behavior, route handlers, database schema, or browser flows.

### Unit (`lane:unit`)

**Purpose:** Fast deterministic checks of pure logic and small modules.

**Runs:** Vitest against `test/**/*.test.*`, excluding `*.integration.test.*`

**Expected to catch:**

- iCalendar formatting and stable UID generation bugs
- environment parsing and validation mistakes
- TMDb payload normalization errors
- token, watchlist, and calendar helper regressions
- component rendering with mocked dependencies

**Not expected to catch:** full server-route wiring, real database behavior, or multi-module runtime integration.

### Integration (`lane:integration`)

**Purpose:** Deterministic application and server-boundary tests that need more realism than unit tests but still run without production secrets or live third-party traffic.

**Runs:** Vitest against `test/**/*.integration.test.*`

**Expected to catch:**

- route-handler behavior with mocked upstream dependencies
- auth and authorization branching across modules
- calendar feed endpoint responses for valid and invalid tokens
- cron or refresh flows with stubbed scheduler and provider calls

**Not expected to catch:** real SQL/RLS behavior, live TMDb responses, or browser-only UI flows.

### Browser (`lane:browser`)

**Purpose:** Full-stack browser coverage for core user journeys using deterministic fixtures and route interception.

**Runs:** Playwright against `e2e/**/*.spec.ts` with the dev server in E2E test mode

**Expected to catch:**

- broken navigation or page rendering in real browser contexts
- search, watchlist, and calendar settings flows that span UI and API boundaries
- regressions in client-side state handling that unit tests do not exercise

**Not expected to catch:** live third-party provider drift, production deployment wiring, or database-specific constraints.

Alias: `npm run e2e` (kept for backward compatibility).

Stability policy for startup conventions, failure artifacts, retries, and quarantine lives in [browser-runtime-test-stability.md](./browser-runtime-test-stability.md).

### Browser quarantine (`lane:browser:quarantine`)

**Purpose:** Run only quarantined browser specs so unstable coverage stays visible without blocking pull requests.

**Runs:** Playwright with `PLAYWRIGHT_QUARANTINE_MODE=quarantine-only` against specs tagged `@quarantine` or listed in `e2e/quarantine.json`.

**Expected to catch:**

- recurring flakes while a linked follow-up issue tracks remediation
- regressions inside already-quarantined coverage

**Merge policy:** Non-blocking. Failures surface in CI for triage but do not fail the default PR gate.

### Real-stack (`lane:real-stack`)

**Purpose:** Validate database schema, migrations, and Postgres-specific constraints against a real Supabase stack.

**Runs:** `npm run db:lint` (wrapper around `supabase db lint`)

**Expected to catch:**

- invalid SQL, migration drift, or schema lint failures
- database objects that no longer match application expectations

**Not expected to catch:** application-layer branching tested with mocks, or browser UI behavior.

The authoritative CI gate is `.github/workflows/supabase-verify.yml`, which starts a local Supabase stack in GitHub Actions. Locally, Docker or a disposable `SUPABASE_DB_URL` is required.

### Full-stack runtime (`lane:full-stack`)

**Purpose:** Exercise one disposable real-backend browser path against Supabase auth, seeded watchlist data, and live calendar-token persistence without widening the deterministic `lane:browser` contract.

**Runs:** `node scripts/ci-full-stack-runtime.mjs`, which seeds a disposable Supabase user and watchlist state, launches Playwright with `playwright.full-stack.config.ts`, then cleans the seeded runtime up.

**Expected to catch:**

- real Supabase email/password sign-in failures
- seeded personal watchlist visibility regressions after a true authenticated redirect
- calendar subscription URL retrieval and token rotation regressions against the live backend
- watchlist deletion persistence bugs that only appear against real Supabase-backed state

**Not expected to catch:** TMDb-dependent add-to-watchlist flows, third-party provider drift, or broad post-deploy wiring outside the disposable Supabase path.

The authoritative CI gate is `.github/workflows/supabase-verify.yml`'s `lane-full-stack-runtime` job, which injects disposable Supabase secrets through GitHub Actions. Locally, the same command can run only when those disposable env vars are present.

### External smoke (`lane:smoke-external`)

**Purpose:** Detect real third-party provider drift without destabilizing ordinary PR validation.

**Status:** Stub lane — implementation tracked in #139.

**Expected to catch (when implemented):**

- live TMDb connectivity or response-shape drift through the app/backend boundary
- environment-specific provider configuration mistakes visible only against real services

**Merge policy:** Non-blocking by default; scheduled or manually triggered.

### Post-deploy smoke (`lane:smoke-post-deploy`)

**Purpose:** Confirm critical deployed runtime paths after release or on a schedule.

**Status:** Stub lane — implementation tracked in #140.

**Expected to catch (when implemented):**

- home page load failures in the hosted environment
- auth-gated path breakage after deploy
- watchlist, search, and feed surfaces that hard-fail only in production wiring

**Merge policy:** Post-deploy or scheduled; not part of the default PR gate.

## Composite commands

| Command | Lanes included |
|---|---|
| `npm run verify` | baseline → unit → integration |
| `npm run lane:all-fast` | same as `verify` (explicit alias) |

## CI naming contract

GitHub Actions workflows and jobs use the `lane-*` prefix so a failing check names the lane directly:

- `verify.yml`: `lane-baseline`, `lane-unit`, `lane-integration`
- `browser-verify.yml`: `lane-browser`, `lane-browser-quarantine`
- `supabase-verify.yml`: `lane-real-stack`, `lane-full-stack-runtime`
- `smoke-external.yml`: `lane-smoke-external` (stub)
- `smoke-post-deploy.yml`: `lane-smoke-post-deploy` (stub)

When a lane fails, fix or investigate within that lane's scope before rerunning unrelated lanes.

## Operating rules

- Add or update tests in the lane that owns the behavior under change.
- Keep fast deterministic lanes free of production secrets, live third-party traffic, and long-lived shared environments.
- Defer real-provider and post-deploy coverage to the smoke lanes (#139, #140) rather than widening the default PR gate.
- State lane impact in PR **Test Impact** sections when a change adds, moves, or renames lane commands or CI jobs.
