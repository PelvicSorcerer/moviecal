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
| External smoke | `npm run lane:smoke-external` | `smoke-external` → `lane-smoke-external` | Heavy | No — scheduled/manual |
| Post-deploy smoke | `npm run lane:smoke-post-deploy` | `smoke-post-deploy` → `lane-smoke-post-deploy` | Heavy | No — post-deploy/scheduled |
| iOS | `xcodebuild build`/`test` in `ios/` (see [iOS lane](#ios-lane)) | `ios-verify` → `lane-ios` | Medium | Required when the owner enables the ruleset check; always reports, runs only for iOS-relevant changes |

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

**Runs:** Vitest against `test/**/*.test.*` and `tools/dispatcher/test/**/*.test.*`, excluding `*.integration.test.*`

**Expected to catch:**

- iCalendar formatting and stable UID generation bugs
- environment parsing and validation mistakes
- TMDb payload normalization errors
- token, watchlist, and calendar helper regressions
- component rendering with mocked dependencies
- dispatcher module-level logic (`tools/dispatcher/src/**`): security policy, worker routing/spawn argument shape, preflight, promotion, and worktree state-file bookkeeping — all against mocked `fs`/`child_process`/Linear/GitHub clients, never a real OS sandbox or a real second process

**Not expected to catch:** full server-route wiring, real database behavior, multi-module runtime integration, or anything that depends on the real macOS Seatbelt sandbox actually applying a profile (see [dispatcher sandbox-exec coverage](#dispatcher-sandbox-exec-integration-macos-only) under Integration).

### Integration (`lane:integration`)

**Purpose:** Deterministic application and server-boundary tests that need more realism than unit tests but still run without production secrets or live third-party traffic.

**Runs:** Vitest against `test/**/*.integration.test.*` and `tools/dispatcher/test/**/*.integration.test.*`

**Expected to catch:**

- route-handler behavior with mocked upstream dependencies
- auth and authorization branching across modules
- calendar feed endpoint responses for valid and invalid tokens
- cron or refresh flows with stubbed scheduler and provider calls

**Not expected to catch:** real SQL/RLS behavior, live TMDb responses, or browser-only UI flows.

#### Dispatcher sandbox-exec integration (macOS only)

`tools/dispatcher/test/worker-guard-sandbox.integration.test.mjs` (MOV-196) is the one exception to "no real OS dependency" in this lane, added after `worker-guard.test.mjs`'s pure string assertions on the generated Seatbelt profile missed real allow/deny regressions (MOV-193, MOV-194). It builds a real multi-worktree Git fixture and actually invokes `/usr/bin/sandbox-exec` with the real generated profile, asserting: a worker can read its own worktree and the shared Git metadata it depends on, and cannot read a sibling worktree's or the main checkout's other working files.

**This only runs on macOS.** `verify.yml`'s `lane-integration` job runs on `ubuntu-latest`, which has no Seatbelt — the suite detects this (`process.platform !== "darwin"` or a missing `/usr/bin/sandbox-exec`) and skips itself cleanly rather than failing, so CI's required check passes without ever exercising this coverage. **The only enforcement is local:** run `npm run lane:integration` on a Mac before sending a change to `tools/dispatcher/src/worker-guard.mjs` (or anything that shapes the sandbox profile) for review.

Not expected to catch: the MOV-180/184 nested-`sandbox_apply` collision specifically — reproducing that via two nested `sandbox-exec` CLI invocations did not trigger a crash when this suite was written (see the note at the bottom of the test file), so that hazard is guarded only at the unit level, by `worker-routing.test.mjs` pinning that Claude's invocation always disables its own internal sandbox.

**Also skips inside a dispatcher worker's own sandbox (MOV-274 follow-up).** This suite's fixture setup, and two otherwise cross-platform suites in this same lane (`startup-recovery.integration.test.mjs`, `worktree-reclaim-concurrency.integration.test.mjs`), shell out to a real `git` binary. When `npm run verify` itself runs as a dispatcher worker (a Claude or Codex worker's assigned verification step, not a human running the command directly), `worker-guard.mjs`'s own Seatbelt profile has already denied `git` process-exec to that worker and everything it spawns — so reaching these fixtures from inside a worker's `npm run verify` is a sandbox denial unrelated to what any of the three suites check, not a real regression. All three read `MOVIECAL_WORKER_SANDBOX` (set only on a worker's own sanitized environment, see `docs/operators/local-execution.md` §Security model) and skip cleanly when it is set, keeping full real-`git`/real-`sandbox-exec` coverage everywhere else: CI, and any human/local `npm run verify`.

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

For the CI-dev secret source, recovery procedure, and production-boundary rules, see [CI-dev Supabase secret recovery](../operators/supabase-ci-secret-recovery.md).

### External smoke (`lane:smoke-external`)

**Purpose:** Detect real third-party provider drift without destabilizing ordinary PR validation.

**Runs:** `scripts/lane-smoke-external.sh`, which hits the TMDb `/3/configuration` endpoint using `TMDB_API_KEY` and verifies an HTTP 200 response containing the expected `images` field.

**Expected to catch:**

- live TMDb connectivity failures (network unreachable, DNS resolution errors)
- invalid or expired `TMDB_API_KEY` (TMDb returns 401)
- unexpected response-shape drift (missing `images` field in the configuration response)
- environment-specific provider configuration mistakes visible only against real services

**Pass/fail criteria:** exits 0 when `TMDB_API_KEY` is set, TMDb returns HTTP 200, and the response body contains `"images"`; exits non-zero with a diagnostic message otherwise. The API key value is never printed.

**Merge policy:** Non-blocking by default; scheduled (weekly on Monday at noon UTC) or manually triggered via `workflow_dispatch`.

### Post-deploy smoke (`lane:smoke-post-deploy`)

**Purpose:** Confirm critical deployed runtime paths after release or on a schedule.

**`SMOKE_URL`:** set to `https://moviecal-nine.vercel.app`, the project's Deployment-Protection-exempt hostname (SSO-protected `*.vercel.app` hosts would otherwise 302 unauthenticated CI requests to a login page). See `docs/technical/deployment-plan.md` for the full rationale.

**Runs:** `scripts/lane-smoke-post-deploy.sh`, which makes four HTTP requests against `SMOKE_URL`: a home page load check (GET `/` → expect 200), a search endpoint query-validation check (GET `/api/movies/search?q=` with a blank query → expect 400 — this route is an intentionally public TMDb passthrough, not auth-gated), a calendar feed token-resolution check (GET `/api/calendar/smoke-test-invalid-token` → expect 404, matching `docs/technical/deployment-plan.md`), and an auth-gate check on a protected route (GET `/api/watchlist` without auth → expect 401).

**Expected to catch:**

- home page load failures in the hosted environment
- search endpoint routing/validation breakage after deploy (e.g. the required `q` param no longer being read or enforced)
- calendar feed token-resolution regressions (e.g. an unresolvable token starting to leak data or returning the wrong status)
- auth-gate breakage after deploy (e.g. a protected route serving data to unauthenticated callers)

**Pass/fail criteria:** exits 0 when `SMOKE_URL` is set and all four HTTP checks return the expected status codes; exits 1 with a diagnostic message on the first failing check. The `SMOKE_URL` value is never printed.

**Merge policy:** Post-deploy or scheduled; not part of the default PR gate.

## iOS lane

The iOS lane is a separate GitHub Actions workflow, `ios-verify` (job `lane-ios`), that always reports on trusted branch pushes. Its lightweight Ubuntu change-detection job runs for every push; `lane-ios` itself runs on the self-hosted macOS runner only when the change set touches `ios/**` or an iOS-lane workflow/policy file. On web-only changes `lane-ios` is skipped, which satisfies the required check without scheduling the Mac runner. The `master-protection` ruleset change that makes this check mandatory remains a separate human-only follow-up.

For every change touching `ios/**`, run `xcodebuild test` locally before opening the PR and review and commit all new or changed snapshot references.

### Simulator lease and memory-aware bounds (MOV-313)

The runner Mac has 8 GB of RAM and one simulator's worth of capacity, shared with manual testing and dispatcher workers. `lane-ios` therefore runs both `xcodebuild` invocations under the machine-wide lease from [iOS simulator lease](../operators/ios-manual-testing.md) (`npm run ios:sim:run -- xcodebuild …`, MOV-309), on the CI lane's own `moviecal-ci` device with its runtime pinned — never the shared `iPhone 17`. The runner service needs `node` on its own PATH, not just in a login shell; a dedicated step fails early and says so if it does not.

- **Waiting is not failing.** If another lane holds the lease, the step logs who holds it and waits up to 30 minutes, then exits `75` with `SIMULATOR_LEASE_UNAVAILABLE` and a GitHub error annotation saying it is an infrastructure wait and safe to re-run. A release step runs `if: always()` so a cancelled job cannot leak the lease; MOV-309's stale-holder takeover is the backstop behind that.
- **Timeouts are sized for a swapping machine, and extend rather than tighten.** `-collect-test-diagnostics never` removes the 10-minute sysdiagnose tail that twice turned a test failure into a 600 s hang. `-parallel-testing-enabled NO` keeps parallel testing from cloning simulators past the one-booted rule. `-test-timeouts-enabled YES` with a 120 s default and 300 s maximum per-test allowance gives a slow simulator grace while failing a wedged one in minutes. The job cap is 40 minutes: above the worst observed passing run plus the lease-wait budget.
- **Element waits.** `SignInToMainTabsUITests` waits 45 s for its elements. They resolve in about a second on an idle machine; the margin exists so swap pressure cannot produce a false red.
- **Concurrency.** A new push to a PR branch cancels that branch's in-progress `ios-verify` run so it stops holding the runner. A push to `master` never cancels an in-progress `master` run.

### Bootstrap state (historical, before `ios/` existed)

- `ios-verify` ran as a successful no-op/config-validation workflow.
- It proved runner routing and basic toolchain presence, including `xcodebuild -version`.

### `#237` / `MOV-104` cutover state (current)

- `ios-verify` builds `ios/Moviecal.xcodeproj` (scheme `Moviecal`) for an iOS Simulator destination via `xcodebuild build`, then runs `xcodebuild test` against the `MoviecalTests` target.
- Minimum required coverage at this point:
  - simulator build
  - at least one trivial XCTest smoke test

### `#238` / `MOV-105` and `#239` / `MOV-106`

- API-client and auth work add XCTest coverage appropriate to their scopes.
- These issues do not require XCUITest or snapshot coverage by default.

### `#240` / `MOV-107` strengthened lane

- `#240` / `MOV-107` is the first issue that must require the full lane:
  - build
  - XCTest
  - XCUITest
  - snapshot coverage for the stable app-shell screens added there

## Deferred coverage rule

- Deferred future testing must never remain implicit.
- If a test layer is intentionally deferred, an existing issue must be updated to carry it or a new follow-up issue must be created before the parent governance issue is considered complete.

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
- `smoke-external.yml`: `lane-smoke-external`
- `smoke-post-deploy.yml`: `lane-smoke-post-deploy`
- `ios-verify.yml`: `lane-ios`

When a lane fails, fix or investigate within that lane's scope before rerunning unrelated lanes.

## Operating rules

- Add or update tests in the lane that owns the behavior under change.
- Keep fast deterministic lanes free of production secrets, live third-party traffic, and long-lived shared environments.
- Defer real-provider and post-deploy coverage to the smoke lanes rather than widening the default PR gate.
- State lane impact in PR **Test Impact** sections when a change adds, moves, or renames lane commands or CI jobs.
- For which lanes are required per change class and what constitutes release confidence, see [release-quality-gates.md](./release-quality-gates.md).
