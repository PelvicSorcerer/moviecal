# Auth and security

## Supabase

- Use Supabase Auth for user sign-in and identity.
- Email/password is sufficient for MVP; OAuth can be added later if needed.
- Enforce Row Level Security on user-owned tables so users can only read and write their own rows.
- Client-safe Supabase values may be exposed to browser code when prefixed with `NEXT_PUBLIC_`.
- The Supabase service-role key stays server-side only and must never be committed.
- The app session should be established server-side with HTTP-only cookies so protected pages and API routes do not rely on client-only auth checks.

## Calendar tokens

- Calendar feed URLs are bearer credentials.
- Store unguessable tokens server-side in `calendar_tokens.token`.
- Token is the only credential required to fetch the public calendar feed; do not require an interactive user session for the feed endpoint.
- Allow users to rotate tokens; rotation invalidates the previous URL.
- Do not log full token values.

## Server secrets

Use environment variables and hosting-provider secret stores. The placeholder names are listed in `.env.example`.

Server-only secrets include:

- `SUPABASE_SERVICE_ROLE_KEY`
- `TMDB_API_KEY`
- `CRON_SECRET`

## Protecting scheduled jobs

- Protect `/api/cron/refresh-releases` with a secret header or an equivalent trusted scheduler mechanism.
- Reject unauthorized refresh attempts.
- Avoid returning sensitive refresh details to unauthorized callers.

## Logging and monitoring

- Log enough context to debug failures without logging secrets or full calendar tokens.
- Consider rate limiting for public calendar feed requests.
- Monitor refresh failures and TMDb rate-limit responses.
