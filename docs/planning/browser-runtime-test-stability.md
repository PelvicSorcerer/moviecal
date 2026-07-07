# Browser and runtime test stability

This document defines the repository policy for keeping browser and runtime-oriented tests operationally reliable, debuggable, and correctly classified when failures are infrastructure flakes rather than product regressions.

For lane commands and CI job names, see [testing-lanes.md](./testing-lanes.md). For environment assumptions, see [test-environment-contract.md](./test-environment-contract.md). For broader test-layer strategy, see [repository-testing-strategy.md](./repository-testing-strategy.md).

## Goals

- Make runtime-oriented failures produce actionable debugging artifacts.
- Keep retry behavior intentionally scoped so flakes are mitigated without hiding regressions.
- Distinguish clearly between blocking regressions and quarantined unstable coverage.

## Startup and readiness conventions

Browser and runtime lanes use shared conventions from `src/lib/test-stability/startup-conventions.ts`:

| Setting | Value | Purpose |
|---|---|---|
| App host | `localhost` | Keep redirects, cookies, and Playwright `baseURL` on one host |
| App port | `3100` | Avoid collisions with default Next.js dev port |
| App URL | `http://localhost:3100` unless `APP_URL` overrides | Playwright `baseURL` and readiness probe |
| E2E test mode | `MOVIECAL_E2E_TEST_MODE=1` | Enables deterministic cookie-backed fixtures |
| Web server startup timeout | 120 seconds | Allows cold CI installs to finish booting |
| Per-test timeout | 30 seconds | Default Playwright spec timeout |

Playwright starts the app through `webServer` in `playwright.config.ts` and waits until `APP_URL` responds before executing specs. Do not point browser lanes at production or long-lived shared environments.

## Failure artifacts

On failure, browser runs capture artifacts under `test-results/playwright/`:

| Artifact | When captured | Purpose |
|---|---|---|
| Screenshot | Test failure | Quick visual state at assertion time |
| Video | Failed test only (`retain-on-failure`) | Replay navigation and UI transitions |
| Trace | First retry in CI, or any failure locally | Inspect network, DOM, and action timeline |
| `failure-summary.json` | Any failed or timed-out test | Machine-readable index of failures and artifact paths |

Inspect artifacts locally with:

```bash
npm run lane:browser
npm run browser:artifacts
```

In CI, the `browser-verify` workflow uploads `test-results/playwright` and `playwright-report` when the blocking browser lane fails.

## Retry and flake-handling policy

Retry behavior is centralized in `src/lib/test-stability/retry-policy.ts` and applied through `playwright.config.ts`.

| Context | Default retries | Override |
|---|---|---|
| Local development | `0` | `PLAYWRIGHT_RETRIES=<n>` |
| CI (`CI=true`) | `2` | `PLAYWRIGHT_RETRIES=<n>` |

Browser specs run with a single worker because E2E fixtures share cookie-backed app state. Parallel workers can collide and produce misleading flakes.

Rules:

1. Retries exist only to absorb timing and infrastructure flakes in runtime lanes.
2. A test that passes only after retry should be investigated as a potential flake; do not treat repeated retries as permanent coverage.
3. Assertion failures that reproduce on the first attempt are blocking regressions even if a later retry would pass.
4. Quarantined tests still run in the separate quarantine lane; retries there inform flake tracking but do not block merges.

## Quarantine policy

A test is **blocking** when it runs in the default `lane:browser` job and is not listed in the quarantine registry or tagged `@quarantine`.

A test is **quarantined** when it is explicitly tracked as unstable and must not block ordinary pull-request validation. Quarantine requires one of:

- an entry in `e2e/quarantine.json` with `testId`, `reason`, `owner`, `trackingIssue`, and `quarantinedAt`, or
- an `@quarantine` tag in the Playwright test title.

Quarantine entries must include a linked follow-up issue (`trackingIssue`) that owns remediation. Do not quarantine tests without an owner and tracking issue.

| Lane | Command | Merge impact |
|---|---|---|
| Blocking browser | `npm run lane:browser` | Fails PR validation |
| Quarantine browser | `npm run lane:browser:quarantine` | Informational only |

The blocking lane skips quarantined tests. The quarantine lane runs only quarantined tests so flakes remain visible without blocking merges.

### When to quarantine versus fix

| Situation | Action |
|---|---|
| Reproducible product regression on first attempt | Fix the product or test; do **not** quarantine |
| Infrastructure flake after retries with no product change | Quarantine with tracking issue, then fix root cause |
| New browser coverage blocked on missing fixture wiring | Keep temporary-manual per [manual-versus-automated-testing-policy.md](./manual-versus-automated-testing-policy.md); quarantine only after the test exists and proves unstable |

Remove quarantine entries in the same pull request that fixes the underlying instability.

## Operating rules

- Add or update quarantine registry entries alongside the linked follow-up issue.
- Prefer fixing root causes over expanding quarantine lists.
- Keep artifact directories (`test-results/`, `playwright-report/`) out of version control.
- Do not store real secrets, tokens, or user data in failure artifacts or summaries.

## Related implementation

- `src/lib/test-stability/` — shared startup, retry, quarantine, and artifact helpers
- `e2e/quarantine.json` — quarantine registry
- `e2e/reporters/failure-summary-reporter.ts` — failure summary writer
- `playwright.config.ts` — browser lane defaults
- `scripts/lane-browser-quarantine.sh` — quarantine-only lane entrypoint
- `scripts/collect-browser-failure-artifacts.sh` — local artifact inspection helper
