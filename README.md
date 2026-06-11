# moviecal

moviecal is a personal movie watchlist web app that lets users search TMDb, save movies to a private watchlist, and subscribe to a private iCalendar (`.ics`) feed compatible with iOS Calendar. The feed provides one all-day event per movie release date and stays up-to-date when release dates change.

Status: Scaffold complete; MVP implementation pending.

## Planned tech stack

- Next.js App Router with strict TypeScript
- Tailwind CSS
- Supabase Auth and Postgres with Row Level Security
- TMDb API for movie metadata
- Vercel hosting and Vercel Cron
- Vitest, Playwright, and GitHub Actions

## Local development

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in local development values.
3. Start the development server: `npm run dev`
4. Run the baseline checks before opening a PR: `npm run verify`

Supabase helper notes:

- Browser-safe and server-only Supabase helpers live under `src/lib/supabase`.
- Supabase helpers validate required environment variables at runtime and reject placeholder values from `.env.example`.
- Server-only helpers fail clearly when `SUPABASE_SERVICE_ROLE_KEY` is missing, and browser helpers never read that variable.

## Agentic development setup

- Use disposable or dev-only credentials for Supabase, TMDb, and cron secrets. Do not use production values for autonomous feature work.
- `.env.example` is placeholder-only. A copied `.env.local` does not mean live integrations are ready.
- Fresh implementation sessions should begin from the single open GitHub issue labeled `agent-ready`.
- Start work from `master` on a branch named `agent/<issue-number>-<short-slug>`.

Local verification commands:

- `npm run verify` runs the baseline lint, typecheck, unit test, and build contract.
- `npm run build` may require elevated execution in Codex because Next.js/Turbopack can hit sandbox restrictions even when the project itself builds correctly.
- `npm run e2e` installs the required Playwright browser automatically before running tests.
- `npm run tool:install` installs workspace-local `vercel`, plus a repo-local Supabase binary path intended for this Apple Silicon macOS machine.
- The Supabase portion of `npm run tool:install` is currently a machine-specific workaround for macOS on Apple Silicon. It downloads the Darwin arm64 archive and may ad-hoc re-sign the binary locally so it can run without a full system-wide install.
- In Codex, `bash scripts/agent-check.sh` may need elevated execution because sandboxed `gh` cannot always see the macOS keychain-backed login even when `gh auth status` succeeds in your normal terminal.
- `npm run tool:check` is safe to run inside Codex; it redirects the Supabase CLI's writable home to a temp directory for the version check.

The current application routes are an early scaffold. Product features such as Supabase auth, TMDb search, persistent watchlists, calendar token rotation, and release-date refresh are planned but not implemented yet.

## Documentation

See `docs/` for product, design, technical, and planning notes. Planning docs describe the intended implementation sequence instead of acting as a progress tracker.

## Security

This is a public repository. Do **not** commit secrets, API keys, service-role keys, `.env` files, tokens, private URLs, or real user data. Keep real values in local environment files and hosting-provider secret stores. See `docs/technical/auth-and-security.md` for details.
