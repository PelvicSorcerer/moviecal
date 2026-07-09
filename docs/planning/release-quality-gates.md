# Release quality gates

This document defines the merge-gate and release-gate expectations for the moviecal repository, organized by change class. Use it to determine which testing lanes are required for a given pull request and what constitutes sufficient confidence for a production release.

For explicit lane commands, CI job names, and what each lane is expected to catch, see [testing-lanes.md](./testing-lanes.md). For the broader testing strategy and capability-to-layer mapping, see [repository-testing-strategy.md](./repository-testing-strategy.md). For environment assumptions by testing mode, see [test-environment-contract.md](./test-environment-contract.md).

## Default merge gate

All pull requests must pass the following four lanes before merging.

| Lane | Command | CI workflow / job | Required |
|---|---|---|---|
| Baseline | `npm run lane:baseline` | `verify` → `lane-baseline` | Yes |
| Unit | `npm run lane:unit` | `verify` → `lane-unit` | Yes |
| Integration | `npm run lane:integration` | `verify` → `lane-integration` | Yes |
| Browser | `npm run lane:browser` | `browser-verify` → `lane-browser` | Yes |

`npm run verify` runs the first three lanes in sequence. The browser lane runs separately via `browser-verify.yml`. Both must be green before a PR can merge.

## Elevated gate

PRs that touch any of the following must pass the elevated gate in addition to the default gate:

- auth logic or session handling
- Supabase schema, migrations, or seed files
- Row-Level Security (RLS) policies
- database-specific constraints or indexes

| Gate | Required lanes | CI trigger |
|---|---|---|
| Default gate | All four lanes above | `verify.yml`, `browser-verify.yml` |
| Elevated gate (adds) | `lane:real-stack` | `supabase-verify` → `lane-real-stack` |

The `supabase-verify.yml` workflow is path-filtered: it triggers automatically on PRs that touch paths under `supabase/`. PRs touching auth or RLS logic elsewhere should manually confirm the elevated gate requirement with the reviewer.

## Smoke signals

`lane:smoke-external` and `lane:smoke-post-deploy` are not blocking on normal PRs.

| Lane | Schedule | Purpose | Merge gate |
|---|---|---|---|
| External smoke (`lane:smoke-external`) | Weekly (Monday noon UTC) or manual | Detects real TMDb connectivity and API-key drift | No |
| Post-deploy smoke (`lane:smoke-post-deploy`) | Post-deploy or scheduled | Confirms critical deployed runtime paths after release | No |

A production release is not considered fully confident until both smoke lanes have passed against the deployed environment since the last release. See the Release confidence section below.

## Release confidence

The combination required for sufficient confidence in a production release:

| Check | Condition |
|---|---|
| Default gate (all four lanes) | Must be green on the release PR |
| `lane:real-stack` | Must be green if the release includes any schema, migration, auth, or RLS changes |
| `lane:smoke-external` | Must pass against the deployed environment after release |
| `lane:smoke-post-deploy` | Must pass against the deployed environment after release |

A release is considered fully confident when all applicable checks above are green on the deployed environment. If schema or auth changes are not included in a release, `lane:real-stack` is not required for that release cycle.

## Change-class table

| Change class | Required gate |
|---|---|
| Pure docs, scripts, governance | Baseline (`lane:baseline`) minimum; full `npm run verify` preferred |
| Product feature (no schema) | Default gate: all four lanes |
| Supabase schema / migration / RLS | Elevated gate: all four lanes + `lane:real-stack` |
| Auth logic or session handling | Elevated gate: all four lanes + `lane:real-stack` |
| Deployment config / cron wiring | Default gate + post-deploy smoke post-release |
| Hotfix | Default gate; if schema or auth touched, elevated gate |
