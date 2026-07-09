-- Grant table-level CRUD to the authenticated role so RLS policies are the
-- sole access-control layer. Supabase's ALTER DEFAULT PRIVILEGES setup is not
-- guaranteed on remote projects bootstrapped via migrations, so explicit grants
-- are required for any table the authenticated client touches directly.
grant select, insert, update, delete on table public.movies to authenticated;
grant select, insert, update, delete on table public.watchlists to authenticated;
grant select, insert, update, delete on table public.watchlist_items to authenticated;
grant select, insert, update, delete on table public.watchlist_memberships to authenticated;
grant select, insert, update, delete on table public.watchlist_invite_links to authenticated;
grant select, insert, update, delete on table public.calendar_tokens to authenticated;

-- anon only needs to read the shared movies cache
grant select on table public.movies to anon;
