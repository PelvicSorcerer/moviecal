# Deployment plan

## Environments

- Development: local Next.js app and local or disposable Supabase project.
- Production: Vercel hosting and Supabase project.

## Environment variables

Use `.env.example` as the canonical placeholder list. Replace placeholders with disposable/dev-only values in `.env.local` for local work, and set the same variable names in the Vercel project for hosted runtime. Do not commit `.env.local`, screenshots of secrets, or copied dashboard values.

| Variable | Local `.env.local` | Vercel project env | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | required | required | browser-safe Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | required | required | browser-safe Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | required | required | server-only Supabase access for protected data and token/feed operations |
| `TMDB_API_KEY` | required | required | server-only TMDb search and refresh access |
| `CRON_SECRET` | required | required | protects `/api/cron/refresh-releases` and authorizes Vercel Cron |

Notes:

- No separate application origin variable is required today; the calendar settings page builds subscription URLs from the incoming request host/protocol headers.
- Supabase itself is the system of record for database schema, RLS, and disposable auth users. Those are configured in the Supabase project, not committed as app secrets in the repository.

## Deployment steps

1. Copy `.env.example` to `.env.local` and replace every placeholder with disposable or dev-only values before local auth, search, watchlist, calendar, or cron testing.
2. Run `npm run build` locally against those disposable/dev-only values so the runtime env contract is validated before deploy.
3. Create or reuse a Supabase project for the target environment.
4. Apply the database schema and RLS migrations to that Supabase project.
5. Create at least one disposable email/password user in Supabase Auth so you can exercise authenticated flows after deploy.
6. Create a Vercel project linked to this GitHub repository.
7. Add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TMDB_API_KEY`, and `CRON_SECRET` to the Vercel project for the environments you plan to deploy.
8. Deploy the Next.js app to Vercel.
9. Keep the repo's `vercel.json` cron entry in place so Vercel schedules `GET /api/cron/refresh-releases` at `0 5 * * *` (05:00 UTC daily).
10. Confirm `CRON_SECRET` is present in Vercel so Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>` to the refresh route.
11. Keep the fallback `x-cron-secret` header documented only for trusted non-Vercel server-side callers when needed; do not normalize it as a public/manual browser workflow.
12. Run the post-deploy smoke checks below.

## Post-deploy smoke checks

Run these checks against the deployed environment using disposable/dev-only credentials:

1. Open `/` and confirm the home page renders without server errors.
2. Open `/sign-in` and confirm the form renders normally.
3. Sign in with a disposable Supabase user and confirm you land on `/watchlist`.
4. Open `/search?q=matrix` and confirm the page can render TMDb-backed results instead of a server error.
5. Add a movie from search, then confirm `/watchlist` shows the saved movie.
6. Open `/settings/calendar` and confirm the page shows a private subscription URL.
7. Open that subscription URL in a separate browser session and confirm the response is `text/calendar`.
8. Change the token in the feed URL to a bogus value and confirm the response is `404`.
9. Request `/api/cron/refresh-releases` without auth and confirm it returns `401`.
10. Confirm a scheduled Vercel Cron invocation reaches `/api/cron/refresh-releases` with bearer auth and no longer fails as unauthorized once `CRON_SECRET` is configured.

## Security notes

- Keep credentials out of the repository.
- Keep real environment values only in local env files and hosting-provider secret stores.
- Do not paste secrets, calendar URLs, or cron headers into public PRs, issues, screenshots, CI logs, or shared shell history.
- Do not paste real calendar tokens in public issues, logs, screenshots, or PR descriptions.
- Treat calendar URLs as bearer credentials.
- Monitor logs for calendar endpoint abuse, TMDb rate limiting, and cron failures.
