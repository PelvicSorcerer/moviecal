# Branch prefixes and CI triggers (single source of truth)

This table is the single source of truth for branch-prefix mapping. When you change a prefix, update this table **and** `docs/operators/branch-prefixes.json` **and** every affected CI workflow's `branches:` filter in the same change, then run `npm run check:branch-ci` (or `bash scripts/check-branch-ci-conventions.py`) to confirm they agree before committing.

`docs/operators/branch-prefixes.json` is the machine-readable version of this same table; `scripts/check-branch-ci-conventions.py` reads it to detect drift automatically. This doc exists for humans and for agents skimming docs — keep the two in sync.

| Prefix | Used by | Requires a path-restricted push trigger? | Notes |
|---|---|---|---|
| `agent/<linear-issue-id>-<short-slug>` | Agent implementation work, any locally-executable worker (Claude Code, Codex), dispatched from a Linear issue or a human direct assignment | Yes | One branch per implementation issue; see `docs/operators/local-execution.md` and `docs/operators/worker-routing.md` |
| `docs/**`, `chore/**` | Governance/queue-maintenance work from any agent or human, not tied to a specific issue | No | Kept separate from `agent/**` feature branches per `AGENTS.md` |

**Prior model (retired):** this repo previously assigned a distinct branch prefix per cloud agent platform (`claude/**`, `cursor/**`, `copilot/**`, plus `orchestrator/**` for a Codex orchestrator's own branch) so that platform-specific CI could be targeted precisely. That model is retired along with the multi-platform cloud-orchestrator governance it supported (see `AGENTS.md` §Historical governance and `docs/operators/local-execution.md`). All locally-dispatched agent work now uses a single `agent/**` prefix regardless of which worker binary implemented it — a worker choice is a routing decision (`docs/operators/worker-routing.md`), not a standing branch-naming privilege.

"Requires a path-restricted push trigger" means: any GitHub Actions workflow that triggers on `push` to a subset of branches (as opposed to `[master]` only, or an unfiltered `pull_request` trigger) must include that prefix's glob if the workflow's guarded paths could plausibly be touched by agent-authored work. The current guarded workflows are listed in `docs/operators/branch-prefixes.json`'s `pathRestrictedPushWorkflows` array so the automated check knows to validate them.

`supabase-verify.yml` deliberately runs on `pull_request` and on `push` to `master`, but not on a feature-branch push. The PR event validates a matching feature change before merge; the `master` push validates the merged result. Running both events for the same PR head starts duplicate heavyweight local-Supabase image pulls and can create avoidable GHCR contention. The real-stack job authenticates the GHCR pulls with its read-only `GITHUB_TOKEN` package scope because `supabase/setup-cli` routes its local image registry there on GitHub-hosted runners. It is therefore excluded from `pathRestrictedPushWorkflows`, whose static branch-prefix check applies only to workflows that depend on a restricted feature-branch push for coverage.

`ios-verify.yml` declares **only** `push` + `workflow_dispatch` — deliberately, since it targets a self-hosted macOS runner and a bare `pull_request` trigger would let an untrusted fork PR execute code on that Mac (see `docs/planning/native-ios-app-plan.md` §Open investigation items). For this workflow a push-branch mismatch is **zero** coverage, not a weaker one: the lane never runs on that PR at all, while the unrelated `verify.yml` Linux lane still goes green, so the PR looks fully checked when it isn't. (`MOV-106` hit exactly this: its branch was created as `claude/mov-106-76983f`, a retired prefix, and would have opened a PR that never ran `ios-verify` had it not been renamed under `agent/**` before pushing.)

## Automated drift check

`scripts/check-branch-ci-conventions.py` (wired up as `npm run check:branch-ci`, and run as a step in `.github/workflows/verify.yml`) runs two checks:

**1. Static drift check (every run).** Parses `docs/operators/branch-prefixes.json` and each workflow listed in `pathRestrictedPushWorkflows`, then fails with a clear message if:

- a prefix marked `requiresPathRestrictedPushTrigger: true` is missing from one of those workflows' push-branch list, or
- one of those workflows lists a push-branch pattern that isn't documented in `branch-prefixes.json` at all (an undocumented prefix is just as much drift as a missing one).

**2. Per-PR branch-trust check (only inside a `pull_request`-triggered job).** For every `pathRestrictedPushWorkflows` entry that has *no* `pull_request:` trigger of its own (today, that's `ios-verify.yml`), fails if this PR's branch doesn't match `trustedSelfHostedExecutionGlobs` (or `master`) **and** the PR's diff touches a path that workflow's push trigger guards — the exact `claude/**`-branch gap above. This check fails open (never blocks) if it can't determine the PR's changed paths — a git/network hiccup should never turn into a spurious failure on an unrelated PR.

Together these turn what would otherwise be a manual audit — and, in the second case, a genuinely easy-to-miss silent gap — into something CI catches automatically on every push and PR.

## Self-hosted iOS workflow

The dedicated iOS workflow is `.github/workflows/ios-verify.yml`.

- It targets runner labels `self-hosted`, `macOS`, and `ios`.
- It may run only on trusted in-repo branch families:
  - `agent/**`
  - `docs/**`
  - `chore/**`
- It should trigger on trusted in-repo branch pushes and manual dispatch, not on `pull_request`.
- Its conditional self-hosted path set in `docs/operators/branch-prefixes.json` should cover both:
  - `ios/**` changes
  - shared docs/config/workflow files that affect iOS dispatch, branch filtering, runner policy, or testing-lane policy
- The workflow itself reports on every trusted branch push. Its Ubuntu change-detection job reads that path set, and only then schedules the self-hosted `lane-ios` job; a skipped `lane-ios` satisfies the required check without consuming the Mac runner.
- Historically, before `ios/` existed, `ios-verify` ran as a successful no-op/config-validation workflow that proved runner routing plus basic toolchain presence, including `xcodebuild -version`.
- `#237` / `MOV-104` switched `ios-verify` from bootstrap mode to real CI: its `lane-ios` job now runs `xcodebuild build` plus `xcodebuild test` (XCTest smoke coverage) against `ios/Moviecal.xcodeproj`.
- `#240` / `MOV-107` is responsible for strengthening the lane to build + XCTest + XCUITest, with snapshot coverage mandatory there.
