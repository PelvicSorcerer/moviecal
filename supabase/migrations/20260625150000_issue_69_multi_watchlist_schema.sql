-- Issue #69 multi-watchlist foundation and personal-watchlist migration.

create table if not exists public.watchlists (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  name text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint watchlists_kind_check check (kind in ('personal', 'shared'))
);

comment on table public.watchlists is
  'First-class watchlists. Every user keeps one owned personal watchlist, and shared watchlists use the same authorization primitives.';
comment on column public.watchlists.owner_user_id is
  'Immutable ownership anchor for personal watchlists and the initial owner of shared watchlists.';
comment on column public.watchlists.kind is
  'Watchlist boundary. Personal and shared watchlists use the same table but differ in access and naming expectations.';

create unique index if not exists watchlists_owner_personal_kind_key
  on public.watchlists (owner_user_id)
  where kind = 'personal';

create index if not exists watchlists_owner_user_id_idx
  on public.watchlists (owner_user_id);

create table if not exists public.watchlist_memberships (
  id uuid primary key default extensions.gen_random_uuid(),
  watchlist_id uuid not null references public.watchlists (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  invited_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  accepted_at timestamptz,
  constraint watchlist_memberships_role_check check (role in ('owner', 'editor')),
  constraint watchlist_memberships_watchlist_id_user_id_key unique (watchlist_id, user_id)
);

comment on table public.watchlist_memberships is
  'Authorization primitive for watchlist access. Later invite acceptance and membership flows should compose with these rows rather than a friend system.';
comment on column public.watchlist_memberships.accepted_at is
  'Null means the membership is not yet active. Accepted memberships authorize access under RLS.';

create index if not exists watchlist_memberships_user_id_idx
  on public.watchlist_memberships (user_id);

create index if not exists watchlist_memberships_watchlist_id_idx
  on public.watchlist_memberships (watchlist_id);

create table if not exists public.watchlist_invite_links (
  id uuid primary key default extensions.gen_random_uuid(),
  watchlist_id uuid not null references public.watchlists (id) on delete cascade,
  created_by_user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint watchlist_invite_links_token_hash_key unique (token_hash),
  constraint watchlist_invite_links_token_hash_length_check check (char_length(token_hash) >= 32)
);

comment on table public.watchlist_invite_links is
  'Invite-link records for shared watchlists. Store only hashed bearer-style invite tokens so a leaked row does not reveal a usable invite secret.';
comment on column public.watchlist_invite_links.token_hash is
  'Hash of the secret invite token. App-layer invite acceptance should compare server-side and must not expose broader user or watchlist discovery.';

create index if not exists watchlist_invite_links_watchlist_id_idx
  on public.watchlist_invite_links (watchlist_id);

create or replace function public.is_watchlist_owner(
  target_watchlist_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.watchlists
    where id = target_watchlist_id
      and owner_user_id = target_user_id
  );
$$;

create or replace function public.is_active_watchlist_member(
  target_watchlist_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.watchlist_memberships
    where watchlist_id = target_watchlist_id
      and user_id = target_user_id
      and accepted_at is not null
  );
$$;

create or replace function public.can_edit_watchlist(
  target_watchlist_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.watchlist_memberships
    where watchlist_id = target_watchlist_id
      and user_id = target_user_id
      and role in ('owner', 'editor')
      and accepted_at is not null
  );
$$;

create or replace function public.ensure_owner_membership_for_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.watchlist_memberships (
    watchlist_id,
    user_id,
    role,
    invited_by_user_id,
    accepted_at
  )
  values (
    new.id,
    new.owner_user_id,
    'owner',
    new.owner_user_id,
    coalesce(new.created_at, timezone('utc', now()))
  )
  on conflict (watchlist_id, user_id) do update
  set
    role = 'owner',
    accepted_at = coalesce(
      public.watchlist_memberships.accepted_at,
      excluded.accepted_at
    );

  return new;
end;
$$;

create or replace function public.ensure_personal_watchlist_for_user(
  target_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  personal_watchlist_id uuid;
begin
  if target_user_id is null then
    return null;
  end if;

  select id
  into personal_watchlist_id
  from public.watchlists
  where owner_user_id = target_user_id
    and kind = 'personal'
  limit 1;

  if personal_watchlist_id is null then
    insert into public.watchlists (owner_user_id, kind, name)
    values (target_user_id, 'personal', 'My watchlist')
    returning id into personal_watchlist_id;
  end if;

  return personal_watchlist_id;
end;
$$;

create or replace function public.sync_watchlist_item_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_watchlist public.watchlists%rowtype;
begin
  if new.watchlist_id is null and new.user_id is not null then
    new.watchlist_id := public.ensure_personal_watchlist_for_user(new.user_id);
  end if;

  if new.watchlist_id is null then
    raise exception 'watchlist_id is required';
  end if;

  select *
  into target_watchlist
  from public.watchlists
  where id = new.watchlist_id;

  if not found then
    raise exception 'watchlist % does not exist', new.watchlist_id;
  end if;

  if target_watchlist.kind = 'personal' then
    new.user_id := target_watchlist.owner_user_id;
  else
    new.user_id := null;
  end if;

  return new;
end;
$$;

revoke all on function public.is_watchlist_owner(uuid, uuid) from public;
revoke all on function public.is_active_watchlist_member(uuid, uuid) from public;
revoke all on function public.can_edit_watchlist(uuid, uuid) from public;
revoke all on function public.ensure_owner_membership_for_watchlist() from public;
revoke all on function public.ensure_personal_watchlist_for_user(uuid) from public;
revoke all on function public.sync_watchlist_item_ownership() from public;

grant execute on function public.is_watchlist_owner(uuid, uuid) to authenticated;
grant execute on function public.is_active_watchlist_member(uuid, uuid) to authenticated;
grant execute on function public.can_edit_watchlist(uuid, uuid) to authenticated;
grant execute on function public.ensure_personal_watchlist_for_user(uuid) to authenticated;

drop trigger if exists ensure_owner_membership_for_watchlist on public.watchlists;

create trigger ensure_owner_membership_for_watchlist
after insert or update of owner_user_id
on public.watchlists
for each row
execute function public.ensure_owner_membership_for_watchlist();

insert into public.watchlists (owner_user_id, kind, name)
select distinct
  watchlist_items.user_id,
  'personal',
  'My watchlist'
from public.watchlist_items
on conflict (owner_user_id) where kind = 'personal' do nothing;

alter table public.watchlist_items
  add column if not exists watchlist_id uuid references public.watchlists (id) on delete cascade;

update public.watchlist_items
set watchlist_id = public.ensure_personal_watchlist_for_user(user_id)
where watchlist_id is null;

alter table public.watchlist_items
  alter column user_id drop not null;

alter table public.watchlist_items
  drop constraint if exists watchlist_items_user_id_movie_id_key;

alter table public.watchlist_items
  add constraint watchlist_items_watchlist_id_movie_id_key unique (watchlist_id, movie_id);

alter table public.watchlist_items
  add constraint watchlist_items_watchlist_id_present_check check (watchlist_id is not null);

comment on table public.watchlist_items is
  'Saved movies scoped to a watchlist. user_id remains as a personal-watchlist compatibility bridge while app-layer shared-watchlist work lands.';
comment on column public.watchlist_items.watchlist_id is
  'Primary watchlist ownership link for both personal and shared watchlists.';
comment on column public.watchlist_items.user_id is
  'Legacy compatibility column for current personal-watchlist code paths. Shared-watchlist rows intentionally store null here.';

create index if not exists watchlist_items_watchlist_id_idx
  on public.watchlist_items (watchlist_id);

drop trigger if exists sync_watchlist_item_ownership on public.watchlist_items;

create trigger sync_watchlist_item_ownership
before insert or update
on public.watchlist_items
for each row
execute function public.sync_watchlist_item_ownership();

alter table public.watchlists enable row level security;
alter table public.watchlist_memberships enable row level security;
alter table public.watchlist_invite_links enable row level security;

drop policy if exists "users can view their own watchlist items" on public.watchlist_items;
drop policy if exists "users can insert their own watchlist items" on public.watchlist_items;
drop policy if exists "users can update their own watchlist items" on public.watchlist_items;
drop policy if exists "users can delete their own watchlist items" on public.watchlist_items;

-- Policy intent:
-- - watchlists, memberships, and invite links are the watchlist authorization boundary.
-- - invite tokens are bearer secrets and should be resolved server-side from hashed values.
-- - watchlist access must compose through membership and invite primitives, not any future friend model.
-- - the current personal-watchlist app path may keep using watchlist_items.user_id while shared-watchlist work migrates the app layer.

create policy "members can view their watchlists"
  on public.watchlists
  for select
  to authenticated
  using (
    public.is_watchlist_owner(id, auth.uid())
    or public.is_active_watchlist_member(id, auth.uid())
  );

create policy "users can create owned watchlists"
  on public.watchlists
  for insert
  to authenticated
  with check (owner_user_id = auth.uid());

create policy "owners can update watchlists"
  on public.watchlists
  for update
  to authenticated
  using (public.is_watchlist_owner(id, auth.uid()))
  with check (owner_user_id = auth.uid());

create policy "owners can delete watchlists"
  on public.watchlists
  for delete
  to authenticated
  using (public.is_watchlist_owner(id, auth.uid()));

create policy "users can view their own memberships"
  on public.watchlist_memberships
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_watchlist_owner(watchlist_id, auth.uid())
  );

create policy "owners can create memberships"
  on public.watchlist_memberships
  for insert
  to authenticated
  with check (public.is_watchlist_owner(watchlist_id, auth.uid()));

create policy "owners can update memberships"
  on public.watchlist_memberships
  for update
  to authenticated
  using (public.is_watchlist_owner(watchlist_id, auth.uid()))
  with check (public.is_watchlist_owner(watchlist_id, auth.uid()));

create policy "owners can delete memberships"
  on public.watchlist_memberships
  for delete
  to authenticated
  using (public.is_watchlist_owner(watchlist_id, auth.uid()));

create policy "owners can manage invite links"
  on public.watchlist_invite_links
  for select
  to authenticated
  using (public.is_watchlist_owner(watchlist_id, auth.uid()));

create policy "owners can create invite links"
  on public.watchlist_invite_links
  for insert
  to authenticated
  with check (
    created_by_user_id = auth.uid()
    and public.is_watchlist_owner(watchlist_id, auth.uid())
  );

create policy "owners can update invite links"
  on public.watchlist_invite_links
  for update
  to authenticated
  using (public.is_watchlist_owner(watchlist_id, auth.uid()))
  with check (
    created_by_user_id = auth.uid()
    and public.is_watchlist_owner(watchlist_id, auth.uid())
  );

create policy "owners can delete invite links"
  on public.watchlist_invite_links
  for delete
  to authenticated
  using (public.is_watchlist_owner(watchlist_id, auth.uid()));

create policy "members can view watchlist items"
  on public.watchlist_items
  for select
  to authenticated
  using (public.is_active_watchlist_member(watchlist_id, auth.uid()));

create policy "editors can insert watchlist items"
  on public.watchlist_items
  for insert
  to authenticated
  with check (public.can_edit_watchlist(watchlist_id, auth.uid()));

create policy "editors can update watchlist items"
  on public.watchlist_items
  for update
  to authenticated
  using (public.can_edit_watchlist(watchlist_id, auth.uid()))
  with check (public.can_edit_watchlist(watchlist_id, auth.uid()));

create policy "editors can delete watchlist items"
  on public.watchlist_items
  for delete
  to authenticated
  using (public.can_edit_watchlist(watchlist_id, auth.uid()));
