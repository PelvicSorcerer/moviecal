# Branch prefixes and CI triggers (single source of truth)

This table is the single source of truth for branch-prefix-to-platform mapping. When you add a new agent platform or change a prefix, update this table **and** `docs/operators/branch-prefixes.json` **and** every affected CI workflow's `branches:` filter in the same change, then run `npm run check:branch-ci` (or `bash scripts/check-branch-ci-conventions.py`) to confirm they agree before committing.

`docs/operators/branch-prefixes.json` is the machine-readable version of this same table; `scripts/check-branch-ci-conventions.py` reads it to detect drift automatically. This doc exists for humans and for agents skimming docs — keep the two in sync.

| Prefix | Used by | Requires a path-restricted push trigger? | Notes |
|---|---|---|---|
| `agent/<issue-number>-<short-slug>` | Codex worker issue branches | Yes | One branch per implementation issue; see `docs/operators/codex.md` and `docs/operators/codex-orchestration.md` |
| `orchestrator/live` (or similar) | Codex orchestrator's own attached branch | No | Tracks `origin/master`; never used for feature work |
| `cursor/<slug>-<run-id>` | Cursor Cloud Agents | Yes | Prefix and suffix are assigned by the Cursor platform, not chosen by the agent; see `docs/operators/cursor-cloud.md` |
| `copilot/**` | GitHub Copilot coding agent | Yes | Assigned by GitHub's Copilot agent platform; see `docs/operators/github-copilot.md` |
| `claude/**` | Claude Code (CLI, web, IDE, or remote execution environment) | Yes | Assigned by the Claude Code platform or a human delegating work; see `docs/operators/claude-code.md` |
| `docs/**`, `chore/**` | Governance/queue-maintenance work from any agent or human | No | Kept separate from `agent/**` feature branches per `AGENTS.md`'s Start conditions |

"Requires a path-restricted push trigger" means: any GitHub Actions workflow that triggers on `push` to a subset of branches (as opposed to `[master]` only, or an unfiltered `pull_request` trigger) must include that prefix's glob if the workflow's guarded paths could plausibly be touched by that platform. The current guarded workflows are listed in `docs/operators/branch-prefixes.json`'s `pathRestrictedPushWorkflows` array so the automated check knows to validate them.

A branch prefix missing from a workflow's `branches:` filter is a real interoperability bug, not a style choice — it silently skips push-triggered CI for that platform. (A PR-triggered run still happens once a PR is opened, since `pull_request` triggers here are not branch-filtered, but that's a weaker safety net than push-triggered CI, and it's exactly how the `cursor/**` gap was found: `agent/**` and `copilot/**` were present in `supabase-verify.yml`'s push trigger but `cursor/**` was missing until it was manually caught and fixed.)

## Automated drift check

`scripts/check-branch-ci-conventions.py` (wired up as `npm run check:branch-ci`, and run as a step in `.github/workflows/verify.yml`) parses `docs/operators/branch-prefixes.json` and each workflow listed in `pathRestrictedPushWorkflows`, then fails with a clear message if:

- a prefix marked `requiresPathRestrictedPushTrigger: true` is missing from one of those workflows' push-branch list, or
- one of those workflows lists a push-branch pattern that isn't documented in `branch-prefixes.json` at all (an undocumented prefix is just as much drift as a missing one).

This turns the manual audit that originally found the `cursor/**` gap into something CI catches automatically on every push and PR, instead of relying on someone noticing during a review.

See `docs/planning/agent-environment-compatibility-plan.md` for the full audit of agent/environment-specific artifacts in this repo and the phased plan this table is part of.

## Self-hosted iOS workflow

The dedicated iOS workflow is `.github/workflows/ios-verify.yml`.

- It targets runner labels `self-hosted`, `macOS`, and `ios`.
- It may run only on trusted in-repo branch families:
  - `agent/**`
  - `orchestrator/**`
  - `cursor/**`
  - `copilot/**`
  - `claude/**`
  - `docs/**`
  - `chore/**`
- It should trigger on both:
  - `ios/**` changes
  - shared docs/config/workflow files that affect iOS dispatch, branch filtering, runner policy, or testing-lane policy
- Before `ios/` exists, `ios-verify` runs as a successful no-op/config-validation workflow and must still prove runner routing plus basic toolchain presence, including `xcodebuild -version`.
- `#237` is responsible for switching `ios-verify` from bootstrap mode to real `xcodebuild` build plus XCTest smoke coverage.
- `#240` is responsible for strengthening the lane to build + XCTest + XCUITest, with snapshot coverage mandatory there.
