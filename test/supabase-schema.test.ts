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
