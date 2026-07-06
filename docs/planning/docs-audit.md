# Documentation audit checklist

Use this checklist when updating docs before or during feature work. It describes what to keep consistent; it is not a historical audit log.

## Core docs to keep aligned

- `README.md`: project purpose, current scaffold status, local setup, security warning.
- `.env.example`: placeholder-only environment variable names.
- `docs/product/*`: MVP scope, requirements, user stories, non-goals.
- `docs/design/*`: page map, app flow, UI principles.
- `docs/technical/*`: architecture, auth/security, data model, API design, calendar feed, TMDb, deployment.
- `docs/planning/repository-testing-strategy.md`: authoritative repository testing policy and test-layer guidance.
- `docs/planning/testing-lanes.md`: explicit lane commands, CI job names, and what each lane is expected to catch.
- `docs/planning/manual-versus-automated-testing-policy.md`: manual-only, temporary-manual, and automated-required check classification; promotion rules for recurring manual regressions.
- `docs/planning/*`: implementation plan, issue hygiene, and recommended sequence.

## Consistency checks

- Route names match the current route plan.
- Environment variable names match `.env.example` and deployment docs.
- Calendar docs consistently require unguessable tokens, `404` for invalid tokens, and stable event UIDs.
- TMDb docs consistently keep API keys server-side only.
- Testing docs distinguish baseline, unit, integration, browser, real-stack, and smoke lanes (see `docs/planning/testing-lanes.md`).
- Planning docs describe what to do next without embedding stale progress tracking.

## Required updates when behavior changes

- Update product requirements when user-visible MVP behavior changes.
- Update API design when endpoint paths, request shapes, or response codes change.
- Update auth/security docs when secrets, token handling, RLS, or cron protection changes.
- Update testing strategy when CI gates or required commands change.
