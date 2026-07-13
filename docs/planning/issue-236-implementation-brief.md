# Issue 236 Implementation Brief

Use this checklist to implement `#236` without reopening policy decisions already settled.

## Required repo deliverables

- Update `AGENTS.md` with a concise pointer to the canonical queue-eligibility flow.
- Add the canonical eligibility algorithm to `docs/operators/codex-orchestration.md`.
- Create or update:
  - `docs/operators/multi-platform-dispatch-policy.md`
  - `docs/operators/branch-and-ci-conventions.md`
  - `docs/operators/branch-prefixes.json`
  - `docs/planning/testing-lanes.md`
  - `docs/planning/native-ios-app-plan.md`
- Add `.github/workflows/ios-verify.yml`.
- Update every affected workflow's `branches:` and path filters in the same change.

## Required GitHub issue actions

- Rewrite `#236` so it matches the settled policy.
- Update `#237` through `#240` so:
  - `#237` owns the real iOS CI cutover and XCTest smoke baseline
  - `#238` explicitly requires XCTest coverage for API client behavior
  - `#239` explicitly requires XCTest coverage for auth behavior
  - `#240` explicitly requires build + XCTest + XCUITest and snapshot coverage
- Create the follow-up tooling issue for:
  - the `Dependencies` project field
  - repo-wide dependency backfill for open issues
  - queue-tooling enforcement and invalid-data human-review behavior

## Required project/admin actions

- Add `Track = iOS` to the project.
- Add `Dependencies` to the project using strict comma-separated issue-number syntax.
- Backfill open issues with dependency data.
- Register the self-hosted runner and apply labels `self-hosted`, `macOS`, and `ios`.

## Closure gates

`#236` is not complete until:

- the docs and workflow artifacts exist
- the GitHub issue updates are complete
- the tooling follow-up issue exists
- the project fields exist
- the open-issue dependency backfill is done
- the self-hosted runner is registered and manually verified
