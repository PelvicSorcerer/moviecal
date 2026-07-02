# GitHub Copilot coding agent operator notes

## Scope

This doc covers what's specific to GitHub Copilot's coding agent when it develops this repo. Read `AGENTS.md` first for the generic contract, and `.github/copilot-instructions.md` too — Copilot's coding agent discovers that file automatically at that fixed path.

## What's verified vs assumed

Everything marked **verified** below was observed in an actual GitHub Copilot coding-agent session against this repo (issue #105, branch `copilot/remaining-issue-fix`, Ubuntu 24.04 / x86_64). Items still marked **assumed** have not been independently confirmed.

## Bootstrap / environment config

- **Verified:** `.github/workflows/copilot-setup-steps.yml` is now present in this repo. It installs Node 24 via `actions/setup-node@v4` and runs `npm ci` before Copilot starts work. This is required because the default Copilot coding-agent VM ships Node 22 (see Node version policy below).
- The `copilot-setup-steps.yml` job name is required by Copilot's platform — do not rename it. The workflow auto-triggers on changes to the file so setup can be validated without a full agent run.
- `.codex/` and `.cursor/` are platform-specific and are not read by Copilot's coding agent.

## Node version policy

- **Policy:** Node **24** (major), matching `.nvmrc`, `package.json` `engines.node` (`>=24`), and CI (`verify.yml`, `supabase-verify.yml`).
- **Verified:** The default Copilot coding-agent VM ships Node **v22.23.0** with npm 10.9.8. `npm install` completes with an `EBADENGINE` warning (`required: >=24, current: v22.23.0`). `npm run verify` (lint → typecheck → test → build) still passes under Node 22 despite the warning, but the repo policy is Node 24.
- **Fix:** `.github/workflows/copilot-setup-steps.yml` installs Node 24 via `actions/setup-node@v4` before Copilot starts work. Do not rely on `.nvmrc` alone — it is not automatically applied in the Copilot runner environment.

## Tool availability

- **Verified:** Docker **is available** on the Copilot coding-agent VM (`docker ps` succeeds, Docker v28.0.4). This differs from Cursor Cloud Agents where Docker is not accessible. Local Supabase stacks (`supabase start`) should be feasible, though not tested in this session.
- **Verified:** `gh` CLI v2.95.0 is available, but `gh auth status` reports "Failed to log in to github.com using token (GITHUB_TOKEN)" — the default `GITHUB_TOKEN` is not a valid `gh` auth credential. Basic push/clone still works through the Copilot platform's own credentials; richer GitHub API calls (`gh project`, `gh issue comment`) may not work without a separate PAT.
- **Verified:** `npm run tool:install` works: it detects `linux/amd64` and installs the workspace-local Supabase CLI (v2.105.0) and Vercel CLI successfully.
- **Verified:** `npm run lint`, `npm run typecheck`, `npm run test` (120/120 tests pass), `npm run build`, `npm run verify`, and `npm run check:branch-ci` all pass.
- **Verified:** `npm run e2e` **fails** — port 3100 is already bound by Copilot's own agent tooling when the agent session is active. This is an intrinsic environment constraint, not a missing dependency. Use the `verify` GitHub Actions workflow as the CI fallback for e2e coverage, the same way Cursor Cloud Agents rely on CI for checks blocked by Docker unavailability.

## Branch convention

- `copilot/**`, assigned by GitHub's Copilot coding agent platform. Already wired into `.github/workflows/supabase-verify.yml`'s push trigger — see `docs/operators/branch-and-ci-conventions.md` for the full cross-platform table.

## Queue governance

- Copilot's coding agent runs one agent per assigned issue/PR, similar to Cursor Cloud Agents; it does not participate in Codex's orchestrator/worker worktree handshake described in `docs/operators/codex-orchestration.md`.
- **GitHub Copilot may not receive `Agent Dispatch = Yes` on any project item.** Product-track feature delivery is owned by Codex workers via the single dispatch slot. See `docs/operators/multi-platform-dispatch-policy.md`.
- Copilot **may** implement platform-track issues (`Track = Platform`), governance/docs work (`docs/**`, `chore/**`), and other tasks when GitHub assigns an issue/PR to Copilot or a human delegates the work. Direct assignment is not dispatch-slot consumption — do not set or assume `Agent Dispatch = Yes`.

## Known gaps / follow-ups

- Local Supabase stack (`supabase start` via Docker) has not been tested in a Copilot coding-agent session. Docker is available but the full stack was not started during the #105 verification run. Use `supabase-verify` CI workflow as the authoritative check for schema/migration correctness.
- The `GITHUB_TOKEN` injected by the Copilot platform is not a usable `gh` CLI credential. If a task requires `gh` API calls (project edits, issue comments), a PAT will be needed — equivalent to the `GITHUB_PAT_OPERATOR` pattern in `docs/operators/cursor-cloud.md`. No Copilot-specific secret injection mechanism has been explored yet.
