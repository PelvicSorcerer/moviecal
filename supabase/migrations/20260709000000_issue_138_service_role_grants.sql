-- Issue #138: Grant service_role access to tables required for CI seeding.
-- service_role bypasses RLS but still needs explicit table-level grants.
-- These grants allow the CI seed script (ci-full-stack-runtime.mjs) to
-- insert and query seed rows via the Supabase admin client.

grant select, insert, update, delete on table public.movies to service_role;
grant select, insert, update, delete on table public.watchlists to service_role;
grant select, insert, update, delete on table public.watchlist_items to service_role;
grant select, insert, update, delete on table public.watchlist_memberships to service_role;
grant select, insert, update, delete on table public.watchlist_invite_links to service_role;
grant select, insert, update, delete on table public.calendar_tokens to service_role;
