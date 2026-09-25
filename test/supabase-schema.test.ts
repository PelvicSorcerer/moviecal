import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { expectTypeOf } from 'vitest';

import type { Database } from '../src/lib/supabase/database';

const migrationPaths = [
  'supabase/migrations/20260611153000_issue_10_initial_schema.sql',
  'supabase/migrations/20260625150000_issue_69_multi_watchlist_schema.sql',
];
const migrationSql = migrationPaths
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const ownershipInvariantsSql = readFileSync(
  'supabase/migrations/20260924000000_mov_330_watchlist_ownership_invariants.sql',
  'utf8',
);

describe('Supabase database types', () => {
  it('declares the personal and shared watchlist tables in the Database shape', () => {
    expectTypeOf<Database['public']['Tables']['movies']['Row']>().toMatchTypeOf<{
      id: number;
      tmdb_id: number;
      title: string;
      release_date: string | null;
      raw_json: unknown;
      updated_at: string;
    }>();

    expectTypeOf<
      Database['public']['Tables']['watchlist_items']['Insert']
    >().toMatchTypeOf<{
      user_id?: string | null;
      movie_id: number;
      watchlist_id?: string | null;
    }>();

    expectTypeOf<
      Database['public']['Tables']['calendar_tokens']['Insert']
    >().toMatchTypeOf<{
      user_id: string;
      token: string;
    }>();

    expectTypeOf<
      Database['public']['Tables']['watchlists']['Insert']
    >().toMatchTypeOf<{
      owner_user_id: string;
      kind: string;
      name: string;
    }>();

    expectTypeOf<
      Database['public']['Tables']['watchlist_memberships']['Insert']
    >().toMatchTypeOf<{
      watchlist_id: string;
      user_id: string;
      role: string;
      accepted_at?: string | null;
    }>();

    expectTypeOf<
      Database['public']['Tables']['watchlist_invite_links']['Insert']
    >().toMatchTypeOf<{
      watchlist_id: string;
      created_by_user_id: string;
      token_hash: string;
    }>();
  });
});

describe('Supabase migration contract', () => {
  it('creates the personal and shared watchlist tables and constraints', () => {
    expect(migrationSql).toContain('create table if not exists public.movies');
    expect(migrationSql).toContain(
      'create table if not exists public.watchlists',
    );
    expect(migrationSql).toContain(
      'create table if not exists public.watchlist_memberships',
    );
    expect(migrationSql).toContain(
      'create table if not exists public.watchlist_invite_links',
    );
    expect(migrationSql).toContain(
      "constraint watchlists_kind_check check (kind in ('personal', 'shared'))",
    );
    expect(migrationSql).toContain(
      "constraint watchlist_memberships_role_check check (role in ('owner', 'editor'))",
    );
    expect(migrationSql).toContain(
      'constraint watchlist_items_watchlist_id_movie_id_key unique (watchlist_id, movie_id)',
    );
    expect(migrationSql).toContain(
      'constraint calendar_tokens_user_id_key unique (user_id)',
    );
    expect(migrationSql).toContain(
      'constraint watchlist_invite_links_token_hash_length_check check (char_length(token_hash) >= 32)',
    );
    expect(migrationSql).toContain(
      'constraint calendar_tokens_token_length_check check (char_length(token) >= 32)',
    );
  });

  it('enables RLS and scopes access through ownership and membership', () => {
    expect(migrationSql).toContain(
      'alter table public.watchlist_items enable row level security;',
    );
    expect(migrationSql).toContain(
      'alter table public.calendar_tokens enable row level security;',
    );
    expect(migrationSql).toContain(
      'alter table public.watchlists enable row level security;',
    );
    expect(migrationSql).toContain(
      'alter table public.watchlist_memberships enable row level security;',
    );
    expect(migrationSql).toContain(
      'alter table public.watchlist_invite_links enable row level security;',
    );
    expect(migrationSql).toContain(
      'public.is_active_watchlist_member(watchlist_id, auth.uid())',
    );
    expect(migrationSql).toContain(
      'public.can_edit_watchlist(watchlist_id, auth.uid())',
    );
    expect(migrationSql).toContain(
      'public.is_watchlist_owner(watchlist_id, auth.uid())',
    );
  });

  it('migrates personal watchlists without losing current semantics', () => {
    expect(migrationSql).toContain(
      'insert into public.watchlists (owner_user_id, kind, name)',
    );
    expect(migrationSql).toContain(
      'update public.watchlist_items',
    );
    expect(migrationSql).toContain(
      'set watchlist_id = public.ensure_personal_watchlist_for_user(user_id)',
    );
    expect(migrationSql).toContain(
      'user_id remains as a personal-watchlist compatibility bridge',
    );
  });

  it('documents the intended security boundary for later auth work', () => {
    expect(migrationSql).toContain('-- Policy intent:');
    expect(migrationSql).toContain(
      'invite tokens are bearer secrets and should be resolved server-side from hashed values',
    );
    expect(migrationSql).toContain(
      'not any future friend model',
    );
  });
});

describe('Watchlist ownership invariants migration (MOV-330)', () => {
  it('repairs existing ownership rows before any invariant binds', () => {
    const backfillIndex = ownershipInvariantsSql.indexOf(
      'insert into public.watchlist_memberships (',
    );
    const triggerIndex = ownershipInvariantsSql.indexOf(
      'create trigger enforce_watchlist_membership_invariants',
    );

    expect(backfillIndex).toBeGreaterThan(-1);
    expect(triggerIndex).toBeGreaterThan(backfillIndex);
    expect(ownershipInvariantsSql).toContain(
      'on conflict (watchlist_id, user_id) do nothing',
    );
    expect(ownershipInvariantsSql).toContain("set role = 'editor'");
  });

  it.each([
    // the owner membership is permanent, accepted, unmovable, and exclusive
    'the watchlist owner membership cannot be removed',
    'the watchlist owner membership cannot be demoted',
    'the watchlist owner membership cannot be reassigned',
    'the watchlist owner membership must remain accepted',
    'only the watchlist owner may hold the owner membership role',
    'before insert or update or delete\non public.watchlist_memberships',
    // owner_user_id and kind are frozen, personal watchlists are undeletable
    'watchlists.owner_user_id is immutable after creation',
    'watchlists.kind is immutable after creation',
    'a personal watchlist cannot be deleted',
    'create policy "owners can delete shared watchlists"',
    // interactive updates are scoped to the name column
    'revoke update on table public.watchlists from authenticated;',
    'grant update (name) on table public.watchlists to authenticated;',
    'create policy "editors can rename shared watchlists"',
    'an accepted editor may update only the shared watchlist name',
    // the account-cascade discriminator for both delete guards
    'if not exists (select 1 from auth.users where id = old.owner_user_id) then',
    'if not exists (select 1 from auth.users where id = old.user_id) then',
  ])('enforces %s', (clause) => {
    expect(ownershipInvariantsSql).toContain(clause);
  });

  it('scopes ensure_personal_watchlist_for_user to the calling user', () => {
    const start = ownershipInvariantsSql.indexOf(
      'create or replace function public.ensure_personal_watchlist_for_user(',
    );
    const body = ownershipInvariantsSql.slice(
      ownershipInvariantsSql.indexOf('as $$', start),
      ownershipInvariantsSql.indexOf('$$;', start),
    );

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('actor_user_id uuid := auth.uid()');
    expect(body).toContain('actor_user_id is not null and actor_user_id <> target_user_id');
    expect(body).toContain(
      'ensure_personal_watchlist_for_user may only be called for the authenticated user',
    );
  });
});
