# moviecal

moviecal is a personal movie watchlist web app that lets users search TMDb, save movies to a private watchlist, and subscribe to a private iCalendar (`.ics`) feed compatible with iOS Calendar. The feed provides one all-day event per movie release date and stays up-to-date when release dates change.

Status: MVP foundation shipped. Local and hosted environments still require real Supabase, TMDb, and cron-secret configuration before authenticated features, calendar feeds, and scheduled refreshes are fully usable.

## Planned tech stack

- Next.js App Router with strict TypeScript
- Tailwind CSS
- Supabase Auth and Postgres with Row Level Security
- TMDb API for movie metadata
- Vercel hosting and Vercel Cron
- Vitest, Playwright, and GitHub Actions

## Local development

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and replace the placeholders with disposable or dev-only values.
3. Start the development server: `npm run dev`
4. Run the baseline checks before opening a PR: `npm run verify`
5. Create a disposable Supabase email/password user if you want to exercise authenticated pages locally.

Supabase helper notes:

- Browser-safe and server-only Supabase helpers live under `src/lib/supabase`.
- Supabase helpers validate required environment variables at runtime and reject placeholder values from `.env.example`.
- Server-only helpers fail clearly when `SUPABASE_SERVICE_ROLE_KEY` is missing, and browser helpers never read that variable.

## Agentic development setup

- This repo supports multiple agent platforms: Codex (via `.codex/environments`, validated on Codex Desktop/macOS), Cursor Cloud Agents (via `.cursor/environment.json`, a generic Ubuntu/x86_64 VM), and GitHub Copilot's coding agent. See `AGENTS.md` for the generic contract; it routes to a per-platform guide under `docs/operators/` (Docker/Supabase CLI availability, branch naming, `gh` auth, and secrets handling differ per platform).
- Use disposable or dev-only credentials for Supabase, TMDb, and cron secrets. Do not use production values for autonomous feature work.
- `.env.example` is placeholder-only. A copied `.env.local` does not mean live integrations are ready.
- Fresh implementation sessions should begin from the single open GitHub issue whose `moviecal Delivery` project item has `Agent Dispatch = Yes` and `Status = Ready`.
- Start work from `master` on a branch named `agent/<issue-number>-<short-slug>`.
- Use an orchestrator step between worker issues to reconcile the project queue and promote the next dispatch issue.
- For implementation issues, the orchestrator should provide an issue-specific manual testing checklist before the branch is considered ready for review.
- Human local testing should run against the pushed worker-owned issue branch before a draft PR is promoted to ready for review.

Local verification commands:

- `npm run verify` runs the baseline lint, typecheck, unit test, and build contract.
- `npm run agent:check` and `npm run agent:handoff` are legacy compatibility checks while the repo finishes migrating queue validation from label/json-based rules to the project-first model.
- `npm run db:lint` is the repo wrapper for `supabase db lint`. It uses `SUPABASE_DB_URL` when you provide a disposable database URL; otherwise it attempts `supabase db lint --local`.
- `.github/workflows/supabase-verify.yml` is the authoritative infra-backed Supabase schema gate for PRs that change database schema verification surfaces.
- `npm run build` may require elevated execution in Codex because Next.js/Turbopack can hit sandbox restrictions even when the project itself builds correctly.
- `npm run e2e` installs the required Playwright browser automatically before running tests and runs against deterministic auth/watchlist fixtures plus Playwright API stubs, so it does not require real Supabase or TMDb secrets.
- `npm run tool:install` installs workspace-local `vercel`, plus a repo-local Supabase binary. It detects OS/arch and supports macOS (Intel/Apple Silicon) and Linux (amd64/arm64); Windows is not supported.
- The Supabase portion of `npm run tool:install` downloads the matching platform archive and, on macOS, may ad-hoc re-sign the binary locally so it can run without a full system-wide install (a no-op on Linux).
- In Codex, `bash scripts/agent-check.sh` may need elevated execution because sandboxed `gh` cannot always see the macOS keychain-backed login even when `gh auth status` succeeds in your normal terminal.
- `npm run tool:check` is safe to run inside Codex; it redirects the Supabase CLI's writable home to a temp directory for the version check.
- In this Codex sandbox, `supabase db lint --local` may still be unavailable even with the CLI installed, because Docker is not present and localhost access to the local Supabase Postgres port can be blocked. In that case, use the PR's `supabase-verify` GitHub Actions workflow as the authoritative DB check, or run `npm run db:lint` with `SUPABASE_DB_URL` pointed at a disposable database.

## Deployment at a glance

- Use `.env.local` only for local development. Do not commit it.
- Set the same runtime variable names in the Vercel project for Preview and Production deployments:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `TMDB_API_KEY`
  - `CRON_SECRET`
- No separate app base-URL environment variable is required today; calendar subscription URLs are derived from request headers in the deployed environment.
- Keep real values in hosting-provider secret stores and Supabase/Vercel dashboards, not in the repository.
- See `docs/technical/deployment-plan.md` for the full deploy runbook and post-deploy smoke checks.

## Current MVP surfaces

The repository now ships the core MVP surfaces needed for deployment validation:

- public home page and sign-in flow
- authenticated search and watchlist pages
- calendar settings with token rotation and a tokenized `.ics` feed route
- protected release-refresh cron endpoint backed by `vercel.json`

## Documentation

See `docs/` for product, design, technical, planning, and operator notes. Planning docs describe the intended implementation sequence instead of acting as a progress tracker.

## Security

This is a public repository. Do **not** commit secrets, API keys, service-role keys, `.env` files, tokens, private URLs, or real user data. Keep real values in local environment files and hosting-provider secret stores. See `docs/technical/auth-and-security.md` for details.
