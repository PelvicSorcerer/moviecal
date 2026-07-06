# Test environment contract

This document defines the authoritative test environment contract for moviecal. Use it to decide which environment assumptions are valid for each testing mode, which credentials and resources are allowed, and which testing surfaces must stay isolated from production or long-lived shared state.

For test-layer ownership and capability mapping, see [repository-testing-strategy.md](./repository-testing-strategy.md). For explicit lane commands and CI job names, see [testing-lanes.md](./testing-lanes.md). For manual-versus-automated classification, see [manual-versus-automated-testing-policy.md](./manual-versus-automated-testing-policy.md).

## Goals

- Keep ordinary pull-request validation deterministic and safe to run without production infrastructure.
- Distinguish clearly between local deterministic testing and heavier real-stack CI validation.
- Require disposable or dev-only credentials, seeded data, and infrastructure in every test mode.
- Exclude production credentials, real user data, and non-disposable shared state from every repository-owned testing workflow.

## Global rules

These rules apply to every testing mode unless a mode says otherwise.

- Use only fake, placeholder, disposable, or dev-only credentials for Supabase, TMDb, cron protection, calendar feeds, and any future integrations.
- Use `.env.example` as the canonical placeholder variable list. Any `.env.local` or CI secret value used for testing must keep the same variable names and must point only at disposable or dev-only resources.
- Seeded data, fixtures, and test accounts must be safe to reset, recreate, or discard without affecting another environment or another person's work.
- Test runs must not depend on production databases, production third-party projects, private user calendars, real watchlists, or any long-lived shared state that cannot be safely reset.
- Examples, screenshots, logs, and documentation must not include real secrets, private URLs, tokens, or real user data.

## Testing modes

### Mode 1: Fast deterministic pull-request validation

This mode covers the default agent-safe gate: baseline, unit, and deterministic integration validation through `npm run verify`.

**Purpose**

- Provide fast regression confidence for most feature work.
- Run safely in local worktrees and standard CI without real infrastructure dependencies.

**Allowed environment shape**

- Placeholder or disposable `.env.local` values.
- Mocked or intercepted TMDb responses.
- Stubbed or seeded auth sessions.
- Mocked Supabase clients or disposable in-memory/test-owned state.

**Required constraints**

- Must stay deterministic across repeated runs.
- Must not require live third-party traffic.
- Must not require production credentials, production databases, or shared mutable environments.

**Typical lanes**

- `lane:baseline`
- `lane:unit`
- `lane:integration`

### Mode 2: Deterministic browser and full-stack local validation

This mode covers browser-driven validation that still runs against a disposable local app/test setup rather than real production wiring.

**Purpose**

- Exercise end-to-end user flows in a real browser while keeping the environment reproducible.
- Validate UI-plus-API behavior without depending on live providers.

**Allowed environment shape**

- A repo-local `.env.local` prepared from `.env.example`.
- Disposable local test accounts, tokens, and seeded state.
- Route interception, provider mocks, or stable fixtures for third-party dependencies.
- Local app server state that can be recreated at will.

**Required constraints**

- Must avoid production or long-lived shared credentials.
- Must use deterministic fixtures or disposable seeded state wherever possible.
- Must not rely on one-off manually curated shared environments.

**Typical lanes**

- `lane:browser`

### Mode 3: Real-stack validation

This mode covers infrastructure-sensitive checks that mocks cannot prove, especially schema and database validation.

**Purpose**

- Prove behavior that depends on real Postgres or Supabase semantics.
- Separate heavier runtime checks from the default PR gate.

**Allowed environment shape**

- Disposable local Supabase or Postgres instances.
- Disposable `SUPABASE_DB_URL` targets.
- CI-provisioned ephemeral services, including the `supabase-verify` workflow.

**Required constraints**

- The database or stack must be disposable, resettable, or ephemeral.
- Credentials must be dev-only and scoped to the test target.
- Shared persistent environments may be used only if they are explicitly disposable for testing and safe to reset without impacting unrelated work.

**Typical lanes**

- `lane:real-stack`

### Mode 4: External and post-deploy smoke validation

This mode covers runtime checks against deployed or provider-backed environments where mocks are intentionally insufficient.

**Purpose**

- Detect deployment-wiring, provider-drift, or hosted-environment failures that do not appear in deterministic local validation.
- Keep these checks out of the fast PR gate unless a future issue explicitly changes the merge contract.

**Allowed environment shape**

- Disposable hosted environments.
- Disposable provider projects or sandbox accounts.
- Disposable/dev-only secrets injected through CI or platform secret stores.

**Required constraints**

- The target environment must not be production unless a separate human release procedure explicitly owns that check outside this repository contract.
- Accounts, datasets, and tokens must be safe to rotate or discard.
- Smoke checks must not depend on private user data or non-disposable shared state.

**Typical lanes**

- `lane:smoke-external`
- `lane:smoke-post-deploy`

## Environment inputs by mode

| Mode | Env vars and secrets | Data shape | Resource expectations |
|---|---|---|---|
| Fast deterministic PR validation | Placeholder, fake, or disposable/dev-only values only | Fixtures, mocks, stubbed sessions, disposable seeded state | No production infra, no live provider dependency |
| Deterministic browser/full-stack local validation | Repo-local `.env.local` from `.env.example`, filled with disposable/dev-only values | Disposable local users, tokens, and seeded app state | Recreatable local app environment, stable fixtures |
| Real-stack validation | Disposable DB URLs, disposable Supabase credentials, ephemeral CI secrets | Resettable schema/test data only | Ephemeral or resettable database/stack |
| External/post-deploy smoke validation | Disposable hosted env secrets, sandbox provider credentials | Disposable accounts and non-sensitive sample data | Disposable hosted targets or explicitly non-production environments |

## Explicit exclusions

The following are outside the contract for all repository-owned testing modes:

- production secrets, production API keys, or production database URLs
- real user accounts, real watchlists, or private user calendar data
- non-disposable shared state that cannot be safely reset
- long-lived personal credentials that are not intended for team-safe test automation
- documentation examples that encourage copying real dashboard values into the repository

If a future workflow needs to touch production or another non-disposable environment, document it as a separate human-operated release procedure rather than extending this repository test contract.

## Ownership and evolution

- This document is the authority surface for test environment assumptions.
- [repository-testing-strategy.md](./repository-testing-strategy.md) owns test-layer strategy and capability mapping.
- [testing-lanes.md](./testing-lanes.md) owns lane names, commands, and CI job mapping.
- [manual-versus-automated-testing-policy.md](./manual-versus-automated-testing-policy.md) owns checklist classification and promotion rules.

Future issues may expand disposable CI backends or hosted smoke implementations, but they should extend this contract rather than create a competing environment-policy document.
