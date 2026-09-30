-- Serialize invite changes on the parent list and keep the old link if an
-- insert fails. Only the signed-in owner can use this RPC.
update public.watchlist_invite_links
set expires_at = created_at + interval '7 days'
where expires_at is null or expires_at > created_at + interval '7 days';

-- Earlier sequential rotations could have left several unrevoked rows.
with ranked as (
  select id, row_number() over (
    partition by watchlist_id order by created_at desc, id desc
  ) as position
  from public.watchlist_invite_links
  where revoked_at is null
)
update public.watchlist_invite_links as links
set revoked_at = now()
from ranked
where links.id = ranked.id and ranked.position > 1;

alter table public.watchlist_invite_links
  alter column expires_at set default (now() + interval '7 days'),
  alter column expires_at set not null;

alter table public.watchlist_invite_links
  add constraint watchlist_invite_links_seven_day_expiry
  check (expires_at <= created_at + interval '7 days');

create unique index watchlist_invite_links_one_unrevoked_per_watchlist
  on public.watchlist_invite_links (watchlist_id)
  where revoked_at is null;

create function public.rotate_watchlist_invite_link(
  target_watchlist_id uuid,
  new_token_hash text
)
returns public.watchlist_invite_links
language plpgsql
security invoker
set search_path = ''
as $$
declare
  locked_watchlist public.watchlists%rowtype;
  created_link public.watchlist_invite_links%rowtype;
  issued_at timestamptz;
begin
  -- Lock even when no invite row exists. A second owner request waits, then
  -- revokes the first request's link before inserting its own.
  select * into locked_watchlist
  from public.watchlists
  where id = target_watchlist_id
  for update;

  if not found or locked_watchlist.kind <> 'shared'
    or locked_watchlist.owner_user_id is distinct from (select auth.uid()) then
    raise exception 'Watchlist access denied.' using errcode = '42501';
  end if;

  if new_token_hash is not null and
    (length(new_token_hash) <> 64 or new_token_hash !~ '^[0-9a-f]+$') then
    raise exception 'Invalid invite hash.' using errcode = '22023';
  end if;

  issued_at := now();
  update public.watchlist_invite_links
  set revoked_at = issued_at
  where watchlist_id = target_watchlist_id and revoked_at is null;

  if new_token_hash is not null then
    insert into public.watchlist_invite_links (
      watchlist_id, created_by_user_id, token_hash, created_at, expires_at
    ) values (
      target_watchlist_id, (select auth.uid()), new_token_hash,
      issued_at, issued_at + interval '7 days'
    ) returning * into created_link;

    return created_link;
  end if;

  -- Revocation has no replacement link. PostgREST serializes this null
  -- composite as an all-null object, which the caller treats as absent.
  return null;
end;
$$;

revoke all on function public.rotate_watchlist_invite_link(uuid, text) from public;
revoke all on function public.rotate_watchlist_invite_link(uuid, text) from anon;
grant execute on function public.rotate_watchlist_invite_link(uuid, text) to authenticated;
