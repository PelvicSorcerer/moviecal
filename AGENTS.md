# Agent Workflow Contract

This repository is prepared for issue-by-issue agent execution. Read this file first, then confirm the current GitHub issue state before changing code.

## Start conditions

- Start implementation only from the single open GitHub issue labeled `agent-ready`.
- Treat GitHub issue state as the operational source of truth when it conflicts with planning docs.
- Do not start feature work from detached `HEAD`; branch from `master`.
- Branch name format: `agent/<issue-number>-<short-slug>` for Codex worker issue branches. Other agent platforms use their own platform-assigned prefix instead (see the branch-prefix table below); do not rename a platform-assigned branch to match this format.
- Governance or queue-maintenance changes should stay separate from feature delivery. Use a `docs/` or `chore/` branch for governance PRs; the persistent orchestrator worktree itself may remain on an attached local branch that tracks `origin/master`.
- Orchestrator audits after merge should run from an attached local branch that tracks `origin/master`; the local branch name does not need to be `master`.

## Branch prefixes and CI triggers (single source of truth)

- This table is the single source of truth for branch-prefix-to-platform mapping. When you add a new agent platform or change a prefix, update this table and every CI workflow `branches:` filter in the same change so they cannot drift apart.

| Prefix | Used by | Notes |
|---|---|---|
| `agent/<issue-number>-<short-slug>` | Codex worker issue branches | One branch per implementation issue; see Orchestrator contract below |
| `orchestrator/live` (or similar) | Codex orchestrator's own attached branch | Tracks `origin/master`; never used for feature work |
| `cursor/<slug>-<run-id>` | Cursor Cloud Agents | Prefix and suffix are assigned by the Cursor platform, not chosen by the agent |
| `copilot/**` | GitHub Copilot coding agent | Assigned by GitHub's Copilot agent platform |
| `docs/**`, `chore/**` | Governance/queue-maintenance work from any agent or human | Kept separate from `agent/**` feature branches per the Start conditions above |

- Any GitHub Actions workflow that triggers on `push` to a subset of branches (for example `.github/workflows/supabase-verify.yml`) must include every prefix in this table that can touch the paths it guards. A branch prefix missing from a workflow's `branches:` filter is a real interoperability bug, not a style choice — it silently skips push-triggered CI for that platform (PR-triggered runs still happen once a PR is opened, since `pull_request` triggers are not branch-filtered here, but that is a weaker safety net than push-triggered CI).
- See `docs/planning/agent-environment-compatibility-plan.md` for the full audit of agent/environment-specific artifacts in this repo and the phased plan for keeping multiple agent platforms compatible without breaking each other.

## Required preflight

- Read `.github/copilot-instructions.md` and the docs linked from the selected issue.
- Confirm the issue is still open, unblocked, and still the only `agent-ready` issue.
- If the issue has been open across later merged feature work, spot-check current repo state against the live acceptance criteria before dispatching a worker so stale `agent-ready` issues are reconciled instead of implemented with a no-op PR.
- Confirm the required environment/tooling for that issue exists before coding.
- Stop and escalate if blocked on secrets, auth, external infrastructure, conflicting issue state, or unclear acceptance criteria.

## Orchestrator contract

- Separate the `orchestrator` role from the `worker` role.
- The official primary worker workflow is `spawn_agent` plus orchestrator-created git worktree isolation. Provision the worker worktree first, let the worker boot naturally, then retarget the worker to the assigned worktree path before substantive work begins.
- The orchestrator owns queue hygiene: issue triage, dependency checks, `agent-ready` promotion/demotion, and post-merge handoff.
- The orchestrator also owns the human-testing handoff: collecting the worker's ready-for-review checkpoint with `wait_agent`, providing an issue-specific manual testing checklist, and deciding when the issue is ready to advance from implementation to review.
- The orchestrator should remain on an attached local branch that tracks `origin/master`, such as `orchestrator/live`, and should not drift onto worker branches while supervising workers.
- The orchestrator owns worker provisioning: use the main repo Codex environment profile, run a worker environment readiness check before dispatch, and create a deterministic issue-centric worktree name that is clearly separate from the orchestrator worktree.
- The worker startup contract is two-step: first collect `BOOT_CHECKPOINT` from the worker's natural startup context, then explicitly retarget the worker to the assigned worktree and require `STARTUP_CHECKPOINT` that matches the assigned worktree path and branch.
- The worker must not start substantive work until the orchestrator validates the second startup gate against the assigned worktree path and branch, preferably through the local wrapper or script gate used for worker dispatch.
- While a worker session is active, the orchestrator must actively collect worker checkpoints with `wait_agent` rather than assuming they will appear without polling.
- After every substantive orchestrator-to-worker instruction, continue the supervision loop until the worker reaches the next explicit gate: ready-for-review, PR-opened/publish, blocker, or explicit completion.
- Do not stop at a polished status summary while a worker is still active; stay in supervision mode until the real gate, blocker, or full review/merge/handoff cycle is complete.
- Require strict machine-parseable `REVIEW_CHECKPOINT` and `PUBLISH_CHECKPOINT` blocks in the worker brief so review handoff and publish state can be collected without ambiguity.
- Routine merge decisions for acceptable worker PRs belong to the orchestrator by default unless the maintainer explicitly withholds merge authority for that run or the PR raises a blocker that genuinely needs human judgment.
- The worker owns exactly one implementation issue, one focused branch, verification, and PR delivery.
- Do not let a worker session self-assign a second implementation issue after finishing the first. Return control to the orchestrator step first.
- The orchestrator should prefer promoting the next dependency-correct issue immediately after a worker issue lands so the repo never sits in an ambiguous "done but not ready" state.
- When multiple open issues could look ready, use `docs/planning/open-issue-order.json` as the deterministic tie-breaker and update that file whenever queue priorities change.
- If no issue is truly ready, the orchestrator should leave zero `agent-ready` issues and record the blocker explicitly in GitHub.
- For feature issues, the orchestrator should ensure the issue body states the expected automated coverage plan and any explicit deferred-coverage follow-up before marking the issue `agent-ready`.

## Handoff contract

- After an implementation PR merges, check an attached local branch that tracks `origin/master`, confirm the merged issue is closed, and reconcile the next queue state before declaring the repo ready again.
- Before an implementation branch is marked ready for review, the orchestrator should collect the worker's ready-for-review checkpoint and hand the human tester an issue-specific checklist derived from `docs/planning/manual-testing-checklist-template.md`.
- Preserve the worker branch and worktree after publish while PR review or CI is still in progress. Clean them up only after merge or explicit abandonment.
- A ready handoff means:
  - a local branch tracking `origin/master` contains the merged change.
  - there are no stray open PRs for the same issue.
  - exactly one open issue is labeled `agent-ready`, unless the queue is intentionally blocked.
  - the promoted issue has current acceptance criteria, verification steps, and security notes when applicable.
- If the next issue depends on missing tooling, secrets, or infrastructure, mark the queue blocked instead of promoting a speculative `agent-ready` issue.

## Environment policy

- The repo's `.codex/environments` profiles and `.codex/scripts` helpers are supported operator tooling for Codex-based development in this repository.
- The validated operator environment for that tooling is Codex Desktop on macOS.
- The same tooling is expected to work in Unix-like Codex environments, but that path is not yet validated in this repo.
- The tooling is not yet validated on Windows.
- When the orchestrator provisions a worker worktree, resolve environment/bootstrap behavior from the main repo `.codex/environments` profile as the source of truth.
- Use disposable or dev-only credentials and resources for Supabase, TMDb, and cron protection.
- Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values and does not mean live integrations are ready.
- The repo-local Supabase/Vercel CLI install path (`npm run tool:install`) supports macOS (Intel/Apple Silicon) and Linux (amd64/arm64); it is not supported on Windows.
- In Codex, GitHub CLI checks may need elevated execution because sandboxed processes may not see the same macOS keychain-backed `gh` login that is available in your normal terminal.

## Cursor Cloud specific instructions

- `.cursor/environment.json` defines the Cursor Cloud Agent environment for this repo. It runs on a generic Ubuntu/x86_64 VM and is independent of the `.codex/environments` profile, which targets Codex Desktop on macOS.
- The `.cursor/environment.json` install script copies `.env.example` to `.env.local` when missing and runs `npm install`. It does not run `.codex/scripts/check-worker-environment.sh`; that script is part of the Codex worker/orchestrator worktree contract described above, not the Cursor Cloud Agent contract.
- `npm run tool:install` works on Cursor Cloud Agent VMs (verified on Ubuntu/x86_64): it detects OS/arch and downloads the matching Supabase CLI release.
- Docker is not present on the default Cursor Cloud Agent VM, so `supabase db lint --local` and any workflow that needs a local Supabase/Postgres stack will not work here either. Use the `supabase-verify` GitHub Actions workflow, or run `npm run db:lint` with a disposable `SUPABASE_DB_URL`.
- Unlike the Codex sandbox caveats noted above, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, and `npm run e2e` (including its automatic `playwright install chromium` step) have been verified to run without elevated execution and without extra system packages on the default Cursor Cloud Agent VM.
- `gh` is preauthenticated on Cursor Cloud Agent VMs and does not have the macOS keychain visibility issue described above for Codex.
- Cursor Cloud Agents branch using the `cursor/<slug>-<run-id>` naming convention supplied by the Cursor platform, which is different from this repo's `agent/<issue-number>-<short-slug>` convention for Codex worker issue branches. Treat both prefixes as valid depending on which system produced the branch; do not rename a Cursor-created branch to match the Codex convention.
- The Codex orchestrator/worker contract in this file (spawn_agent, worktree provisioning, `BOOT_CHECKPOINT`/`STARTUP_CHECKPOINT` gates) is specific to Codex's multi-agent tooling and does not apply to Cursor Cloud Agents, which run as a single agent per task/PR with no equivalent orchestrator step. A Cursor Cloud Agent can still pick up the single `agent-ready` issue and follow the branch/PR/verification expectations elsewhere in this file, but it cannot participate in the Codex orchestrator/worker handshake.
- For real (disposable/dev-only) Supabase, TMDb, and cron-secret values, prefer the Secrets tab in Cursor Dashboard → Cloud Agents over editing `.env.local` by hand. Secrets are injected as process environment variables, which Next.js reads at build and runtime even without a matching `.env.local` entry; use the exact variable names from `.env.example`.

## Verification contract

- Baseline verification: `npm run verify`
- Production build: `npm run build`
- E2E: `npm run e2e`
- Human local testing should happen on the pushed worker-owned issue branch before the PR is promoted from draft or work-in-progress to ready for review.
- Each implementation issue should produce an explicit manual testing checklist with setup assumptions, happy-path steps, edge cases, regression checks, and expected results.
- Each implementation issue should either land its intended automated coverage or identify the immediate feature-specific follow-up issue for any deferred Playwright coverage before review handoff.
- Update docs when routes, environment variables, verification commands, or security assumptions change.

## Session workflow

- Use dedicated prep/governance sessions for repo hardening only.
- Use a fresh session for each implementation issue.
- When using a fresh worker worktree, let the worker emit `BOOT_CHECKPOINT` from its natural startup context first. After the orchestrator retargets the worker to the assigned worktree, require `STARTUP_CHECKPOINT` and validate the assigned path, branch, and starting commit before allowing substantive work.
- If the worker starts on detached `HEAD`, confirm that commit matches `origin/master` and create the issue branch immediately from that verified commit.
- Keep PR scope to one issue unless the issue explicitly says otherwise.
- After governance changes, update the queue guidance docs and issue templates in the same PR when they change operator behavior.
