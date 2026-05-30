# Auth and security

Supabase
- Use Supabase Auth for user sign-in and identity (email/password, OAuth optional).
- Enforce Row Level Security (RLS) on watchlist_items so users can only read/write their own rows.
- Public anon key is safe to ship to the client where Supabase requires it; service_role key stays server-side and is NOT committed.

Calendar tokens
- Calendar feed uses an unguessable token stored server-side (calendar_tokens.token).
- Token is the only credential required to fetch the public .ics feed — do not accept user session to that endpoint.
- Allow users to rotate tokens; when rotated, previous URL should be invalidated.

Server secrets
- Store secrets in environment variables (Vercel project settings / Supabase Secrets). Never commit them.
- Example env variables to set: SUPABASE_URL, SUPABASE_ANON_KEY (client-safe), SUPABASE_SERVICE_ROLE_KEY (server-only), TMDB_API_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY (if used).

Protecting scheduled jobs
- Protect the /api/refresh endpoint with a Vercel Cron secret header or use Supabase server-side functions so only the scheduler can call it.

Other notes
- Log access to calendar endpoints (rate-limited) to detect abuse.
- Consider short-term token revocation and monitoring.
