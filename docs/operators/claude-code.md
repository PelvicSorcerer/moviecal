# Claude Code operator notes

Read `AGENTS.md` first.

## Scope

This doc covers what's specific to Claude Code (CLI, web, IDE extensions, or remote execution environment) when it develops this repo: environment bootstrap, tool availability, branch convention, and queue-interaction notes. The generic contract in `AGENTS.md` applies to every platform; this doc only lists what differs.

## What's verified vs assumed

Items marked **verified** were observed in an actual Claude Code session against this repo. Items marked **assumed** have not been independently confirmed in this repo yet.

- **Verified (issue #163):** `CLAUDE.md` at repo root loads via the `@AGENTS.md` import directive, so a fresh Claude Code session reads repo instructions through this file.
- **Assumed:** Tool availability and environment details below are based on Claude Code's published documentation and the managed remote execution environment, not a full local-validation pass.

## Bootstrap / environment config

- Claude Code reads `CLAUDE.md` at the repo root on session start. `CLAUDE.md` imports `AGENTS.md` via `@AGENTS.md`, so the full generic contract loads automatically.
- No additional platform-specific config file (analogous to `.codex/environments/*.toml` or `.cursor/environment.json`) is required for basic Claude Code operation. The remote execution environment clones the repo fresh and runs in an isolated container.
- Copy `.env.example` to `.env.local` if missing and fill in disposable/dev-only credentials before running any command that touches Supabase, TMDb, or cron endpoints.
- Node version policy: **Node 24** (major), matching `.nvmrc`, `package.json` `engines.node` (`>=24`), and CI. Verify with `node --version` before running `npm install`.

## Tool availability quirks

- **`gh` CLI:** Available in the managed remote execution environment. The environment's GitHub App token supports clone/push but richer API calls (`gh project`, `gh issue comment`) require the GitHub MCP server tools instead (prefixed `mcp__github__`); do not use `gh` for project or issue API calls.
- **Docker:** Not available in the default managed remote execution environment. `supabase db lint --local` is therefore unavailable. Use the `supabase-verify` GitHub Actions workflow as the authoritative DB gate, or point `SUPABASE_DB_URL` at a disposable database.
- **Browser/Playwright:** Chromium is pre-installed (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). `npm run lane:browser` (alias: `npm run e2e`) should work without a separate `playwright install` step. Do not run `playwright install`.
- **`jq`:** Assumed available; required for `scripts/lib/project-queue-common.sh` and related governance scripts.
- **`npm run verify`** (`lane:baseline`, `lane:unit`, `lane:integration`): assumed to run without elevated execution in the remote container.
- **`npm run lane:real-stack`** (alias: `npm run db:lint`): blocked without Docker or a reachable Supabase Postgres port. Use CI or `SUPABASE_DB_URL`.

## Branch convention

- `claude/<issue-number>-<short-slug>` for Claude Code issue branches. Example: `claude/work-issue-163-eyf8vy`.
- The branch prefix `claude/**` is wired into the path-restricted push trigger in `.github/workflows/supabase-verify.yml` and documented in `docs/operators/branch-and-ci-conventions.md` and `docs/operators/branch-prefixes.json`.
- Branch from `master`; do not branch from a detached `HEAD`.

## Queue / dispatch interaction

- **Claude Code may not receive `Agent Dispatch = Yes` on any project item.** Dispatch-slot work on `Product` or `Future` tracks is owned by Codex workers. See `docs/operators/multi-platform-dispatch-policy.md`.
- Claude Code **may** implement platform-track issues (`Track = Platform`), governance/docs work (`docs/**`, `chore/**`), and other tasks when a human assigns the issue or delegates it directly. Direct assignment is not dispatch-slot consumption — do not set or assume `Agent Dispatch = Yes`.
- Treat the `moviecal Delivery` GitHub Project as the source of truth for queue state, even though Claude Code cannot update project fields natively. If a project update is needed, note it in the PR description and ask the human to update the project field.

## Secrets

- Use disposable or dev-only credentials for Supabase, TMDb, and cron protection. Do not use production secrets, long-lived personal credentials, or private user data.
- `.env.example` is placeholder-only. `.env.local` may exist with placeholder values.
- The remote execution environment does not persist credentials across sessions; re-supply any needed secrets at session start.

## Known gaps / follow-ups

- A full verification pass of `npm run verify`, `npm run lane:browser`, and `npm run tool:install` inside the managed remote execution environment has not been recorded yet. The platform-specific notes above should be updated once that pass is complete.
- Local Supabase stack (`supabase start` via Docker) has not been tested in a Claude Code session. Use `supabase-verify` CI workflow as the authoritative check for schema/migration correctness.
