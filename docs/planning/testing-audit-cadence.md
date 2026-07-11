# Automated-testing audit cadence

This document defines when the repository's testing health is reviewed, what is checked, and how findings re-enter the project queue. It is part of the testing governance program tracked in #122.

For the check classifications (automated-required, temporary-manual, manual-only) that determine which gaps are promotion candidates, see [manual-versus-automated-testing-policy.md](./manual-versus-automated-testing-policy.md). For the capability-to-layer map used to assess coverage gaps, see [repository-testing-strategy.md](./repository-testing-strategy.md). For quarantine rules, see [browser-runtime-test-stability.md](./browser-runtime-test-stability.md).

## Trigger

An audit is due on every **tenth merged PR** — that is, any PR whose number ends in `0` (e.g. #200, #210, #220). GitHub issues and PRs share a counter, so this is an approximation; the actual interval between `0`-ending PRs varies.

The agent that merges that PR is responsible for running the audit as part of post-merge handoff, immediately after the normal handoff checklist. No separate scheduling is needed.

If the responsible agent cannot complete the audit (blocked, insufficient context, or session ends), it must leave a comment on the PR noting the audit was skipped and why, so the next session can pick it up.

## What to check

Work through each area in order. Each area has a concrete command or inspection step and a clear pass/fail criterion.

### 1. Quarantined tests

Scan `test/` and `e2e/` for any `.skip(` or `@quarantine` markers:

```bash
grep -rn "\.skip\|@quarantine" test/ e2e/ --include="*.ts" --include="*.tsx" || echo "none found"
```

**Fail criterion:** Any test that has been quarantined (skipped or marked) across two or more consecutive audit cycles without a named blocker issue. File a follow-up issue for each.

### 2. Promotion candidates from manual checklists

Review the manual testing checklists for PRs merged since the last audit. Look for any step that appeared in two or more checklists — these are promotion candidates per the triggers in [manual-versus-automated-testing-policy.md](./manual-versus-automated-testing-policy.md).

Concretely: scan the bodies of PRs merged since PR `N-10` (where `N` is the current trigger PR number) for repeated checklist items.

**Fail criterion:** Any repeated manual step that does not already have a named follow-up issue. File one.

### 3. Surface drift

```bash
npm run check:surface-drift
```

This script compares registered API routes against the capability-to-layer map in `repository-testing-strategy.md`. Any route not referenced in either `docs/planning/repository-testing-strategy.md` or a test file is flagged as a gap.

**Fail criterion:** Any uncovered route that is not already tracked in an open issue. File one.

### 4. Lane performance

Run the default gate and record the wall-clock time for each lane:

```bash
time npm run verify
```

**Fail criterion:** Any lane that takes more than 2× its baseline duration (baseline: `lane:baseline` ~15 s, `lane:unit` ~30 s, `lane:integration` ~30 s). Investigate before filing — a slow lane may indicate a newly added test with a real network call or a missing mock, not just natural growth.

## How to file a finding

Each finding becomes a GitHub issue. Use the `agent_task.md` template when the work is agent-executable.

Required fields when creating the issue:
- Title: short, specific, and actionable (e.g. "Automate watchlist redirect regression check")
- Body: link the audit that surfaced the gap (PR number), the check area, and the acceptance criteria
- Link to #122 as the parent tracking issue ("Part of #122")
- Project fields: `Track = Future`, `Execution Mode = Agent` (if automatable) or `Human`, `Agent Dispatch = No`, `Priority` based on severity

Post the new issue numbers as a comment on the trigger PR so the audit trail is visible in the PR thread.

## Findings that need no issue

Skip filing an issue when:
- A quarantined test already has a named follow-up issue linked from its skip annotation.
- A surface-drift gap is already tracked in an open issue.
- A slow lane was slow last cycle too and already has an open issue.

In those cases, note the finding in the trigger-PR comment anyway, with the existing issue number.

## Audit summary comment format

Post one comment on the trigger PR with this structure:

```
## Testing audit — PR #NNN

**Quarantined tests:** [pass / N findings — issue #NNN]
**Promotion candidates:** [pass / N findings — issue #NNN, #NNN]
**Surface drift:** [pass / N findings — issue #NNN]
**Lane performance:** [pass / lane:unit 28 s (ok), lane:integration 31 s (ok), ...]

Next audit due: PR #NNN+10
```
