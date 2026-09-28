-- MOV-407: INSERT ... RETURNING must authorize the new watchlist row
-- directly. A STABLE helper scanning watchlists cannot see a row inserted by
-- the same command. Keep accepted-member access and the existing write guards.
alter policy "members can view their watchlists"
  on public.watchlists
  using (
    owner_user_id = auth.uid()
    or public.is_active_watchlist_member(id, auth.uid())
  );
