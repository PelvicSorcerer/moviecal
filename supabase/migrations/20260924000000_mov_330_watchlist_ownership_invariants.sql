-- MOV-330: Harden shared-watchlist ownership, personal-list, and editor-name
-- invariants at the database boundary.
--
-- 20260625150000 made watchlists, memberships, and invite links the
-- authorization primitives, but the invariants they imply were enforced only by
-- application code. A direct authenticated PostgREST call — or a service-role
-- path with a bug in it — could still delete or demote the owner's own
-- membership row (silently revoking the owner's edit access, because
-- can_edit_watchlist() reads memberships), hand the 'owner' role to a
-- non-owner, retarget owner_user_id or kind, delete a personal watchlist along
-- with every movie in it, or call ensure_personal_watchlist_for_user() for an
-- arbitrary account.
--
-- Three layers close those holes, each failing closed on its own: column-scoped
-- grants, narrowed RLS policies, and row triggers that bind the service role
-- too. No existing row is dropped or rewritten beyond the repair in section 1.

-- ---------------------------------------------------------------------------
-- 1. Repair existing data before the invariants bind. These run before any new
--    trigger exists, so they cannot trip one.
-- ---------------------------------------------------------------------------

-- Every watchlist must have its owner's membership row. 20260625150000's
-- trigger creates one on insert, but nothing stopped a later delete.
insert into public.watchlist_memberships (
  watchlist_id,
  user_id,
  role,
  invited_by_user_id,
  accepted_at
)
select
  watchlists.id,
  watchlists.owner_user_id,
  'owner',
  watchlists.owner_user_id,
  coalesce(watchlists.created_at, timezone('utc', now()))
from public.watchlists
on conflict (watchlist_id, user_id) do nothing;

-- An owner membership that was demoted or left pending is restored in place so
-- the accepted-owner invariant below holds for pre-existing rows.
update public.watchlist_memberships as memberships
set
  role = 'owner',
  accepted_at = coalesce(
    memberships.accepted_at,
    watchlists.created_at,
    timezone('utc', now())
  )
from public.watchlists
where memberships.watchlist_id = watchlists.id
  and memberships.user_id = watchlists.owner_user_id
  and (memberships.role <> 'owner' or memberships.accepted_at is null);

-- Only the real owner may hold the 'owner' role. A non-owner that somehow holds
-- it keeps its access as an editor rather than losing the membership entirely.
update public.watchlist_memberships as memberships
set role = 'editor'
from public.watchlists
where memberships.watchlist_id = watchlists.id
  and memberships.user_id <> watchlists.owner_user_id
  and memberships.role = 'owner';

-- ---------------------------------------------------------------------------
-- 2. ensure_personal_watchlist_for_user is SECURITY DEFINER and executable by
--    `authenticated`, so PostgREST exposes it as an RPC to every signed-in
--    user. Without a self-check any of them could create a personal watchlist
--    for an arbitrary account and learn its id. A null auth.uid() is the
--    trusted server-only path: the service-role client (built only by
--    createServerSupabaseServiceRoleClient, never shipped to a browser), cron,
--    migrations, and psql all present no end-user subject.
-- ---------------------------------------------------------------------------

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
  actor_user_id uuid := auth.uid();
begin
  if target_user_id is null then
    return null;
  end if;

  if actor_user_id is not null and actor_user_id <> target_user_id then
    raise exception
      'ensure_personal_watchlist_for_user may only be called for the authenticated user'
      using errcode = 'insufficient_privilege';
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

comment on function public.ensure_personal_watchlist_for_user(uuid) is
  'Returns (creating if needed) the caller''s personal watchlist. Authenticated callers may only pass their own id; a null auth.uid() is the trusted server-only path.';

-- These SECURITY DEFINER helpers are also callable as authenticated RPCs.
-- Bind their user argument to the JWT subject to prevent cross-user membership
-- and ownership probes. RLS already passes auth.uid() on every call.
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
      and target_user_id = auth.uid()
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
      and target_user_id = auth.uid()
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
      and target_user_id = auth.uid()
      and role in ('owner', 'editor')
      and accepted_at is not null
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Watchlist row invariants.
--
--    Telling an account deletion apart from an application delete: auth.users
--    cascades into public.watchlists, and the referenced row is already gone
--    from this transaction's snapshot by the time the cascade fires the child
--    trigger. A still-present owner therefore means a deliberate delete.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_watchlist_update_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
begin
  if new.id is distinct from old.id then
    raise exception 'watchlists.id is immutable'
      using errcode = 'check_violation';
  end if;

  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'watchlists.owner_user_id is immutable after creation'
      using errcode = 'check_violation';
  end if;

  if new.kind is distinct from old.kind then
    raise exception 'watchlists.kind is immutable after creation'
      using errcode = 'check_violation';
  end if;

  new.created_at := old.created_at;

  -- An accepted editor reaches this trigger through the shared-watchlist rename
  -- policy below. Comparing whole rows rather than a column allowlist means a
  -- column added later is refused until it is deliberately opened up.
  if actor_user_id is not null and actor_user_id is distinct from old.owner_user_id then
    if old.kind <> 'shared' then
      raise exception 'only the owner may update a personal watchlist'
        using errcode = 'insufficient_privilege';
    end if;

    if (to_jsonb(new) - 'name'::text - 'updated_at'::text)
       is distinct from (to_jsonb(old) - 'name'::text - 'updated_at'::text) then
      raise exception 'an accepted editor may update only the shared watchlist name'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  new.updated_at := timezone('utc', now());

  return new;
end;
$$;

create or replace function public.enforce_watchlist_delete_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.kind <> 'personal' then
    return old;
  end if;

  if not exists (select 1 from auth.users where id = old.owner_user_id) then
    return old;
  end if;

  raise exception 'a personal watchlist cannot be deleted'
    using errcode = 'insufficient_privilege';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Membership row invariants: the real owner membership is permanent,
--    unmovable, accepted, and exclusive.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_watchlist_membership_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_owner_user_id uuid;
  target_owner_user_id uuid;
begin
  if tg_op = 'DELETE' then
    select owner_user_id
    into previous_owner_user_id
    from public.watchlists
    where id = old.watchlist_id;

    -- The watchlist is already gone: this is its ON DELETE CASCADE, not a
    -- membership removal.
    if not found then
      return old;
    end if;

    if old.user_id is distinct from previous_owner_user_id then
      return old;
    end if;

    -- The account is already gone: this is auth.users' ON DELETE CASCADE.
    -- Cascade order between the two foreign keys is not guaranteed, so the
    -- owner's membership can reach this trigger before its watchlist does.
    if not exists (select 1 from auth.users where id = old.user_id) then
      return old;
    end if;

    raise exception 'the watchlist owner membership cannot be removed'
      using errcode = 'insufficient_privilege';
  end if;

  select owner_user_id
  into target_owner_user_id
  from public.watchlists
  where id = new.watchlist_id;

  -- No watchlist to judge against. That is the foreign key's decision to make,
  -- not this trigger's: raising here would also turn a benign cascade-ordering
  -- interleaving (auth.users' ON DELETE SET NULL on invited_by_user_id landing
  -- after the watchlist is gone) into a failed account deletion.
  if not found then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    select owner_user_id
    into previous_owner_user_id
    from public.watchlists
    where id = old.watchlist_id;

    if previous_owner_user_id is not null
      and old.user_id = previous_owner_user_id
      and (
        new.watchlist_id is distinct from old.watchlist_id
        or new.user_id is distinct from old.user_id
      )
    then
      raise exception 'the watchlist owner membership cannot be reassigned'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.user_id = target_owner_user_id then
    if new.role <> 'owner' then
      raise exception 'the watchlist owner membership cannot be demoted'
        using errcode = 'insufficient_privilege';
    end if;

    if new.accepted_at is null then
      raise exception 'the watchlist owner membership must remain accepted'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.role = 'owner' then
    raise exception 'only the watchlist owner may hold the owner membership role'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_watchlist_update_invariants() from public;
revoke all on function public.enforce_watchlist_delete_invariants() from public;
revoke all on function public.enforce_watchlist_membership_invariants() from public;

drop trigger if exists enforce_watchlist_update_invariants on public.watchlists;

create trigger enforce_watchlist_update_invariants
before update
on public.watchlists
for each row
execute function public.enforce_watchlist_update_invariants();

drop trigger if exists enforce_watchlist_delete_invariants on public.watchlists;

create trigger enforce_watchlist_delete_invariants
before delete
on public.watchlists
for each row
execute function public.enforce_watchlist_delete_invariants();

drop trigger if exists enforce_watchlist_membership_invariants
  on public.watchlist_memberships;

create trigger enforce_watchlist_membership_invariants
before insert or update or delete
on public.watchlist_memberships
for each row
execute function public.enforce_watchlist_membership_invariants();

-- ---------------------------------------------------------------------------
-- 5. Column-scoped UPDATE privilege. `name` is the only column any interactive
--    user may name in an UPDATE against public.watchlists; the trigger above
--    still stamps updated_at, because column privileges are checked against the
--    statement's SET list rather than against what a trigger changes.
-- ---------------------------------------------------------------------------

revoke update on table public.watchlists from authenticated;
grant update (name) on table public.watchlists to authenticated;

-- ---------------------------------------------------------------------------
-- 6. RLS. Owners keep full control of shared watchlists; accepted editors gain
--    a rename-only UPDATE path; nobody may delete a personal watchlist.
-- ---------------------------------------------------------------------------

drop policy if exists "owners can delete watchlists" on public.watchlists;
drop policy if exists "owners can delete shared watchlists" on public.watchlists;

create policy "owners can delete shared watchlists"
  on public.watchlists
  for delete
  to authenticated
  using (
    kind = 'shared'
    and public.is_watchlist_owner(id, auth.uid())
  );

drop policy if exists "editors can rename shared watchlists" on public.watchlists;

create policy "editors can rename shared watchlists"
  on public.watchlists
  for update
  to authenticated
  using (
    kind = 'shared'
    and public.can_edit_watchlist(id, auth.uid())
  )
  with check (
    kind = 'shared'
    and public.can_edit_watchlist(id, auth.uid())
  );

comment on table public.watchlists is
  'First-class watchlists. owner_user_id and kind are immutable after creation, personal watchlists are undeletable while their owner exists, and accepted editors may change only a shared watchlist name.';
comment on table public.watchlist_memberships is
  'Authorization primitive for watchlist access. The owner''s membership row is permanent, accepted, unmovable, and the only row that may hold the owner role.';
