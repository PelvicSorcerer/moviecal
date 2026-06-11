import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { expectTypeOf } from 'vitest';

import type { Database } from '../src/lib/supabase/database';

const migrationPath =
  'supabase/migrations/20260611153000_issue_10_initial_schema.sql';
const migrationSql = readFileSync(migrationPath, 'utf8');

describe('Supabase database types', () => {
  it('declares the issue #10 tables in the generated Database shape', () => {
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
      user_id: string;
      movie_id: number;
    }>();

    expectTypeOf<
      Database['public']['Tables']['calendar_tokens']['Insert']
    >().toMatchTypeOf<{
      user_id: string;
      token: string;
    }>();
  });
});

describe('Supabase migration contract', () => {
  it('creates the issue #10 tables and constraints', () => {
    expect(migrationSql).toContain('create table if not exists public.movies');
    expect(migrationSql).toContain(
      'constraint watchlist_items_user_id_movie_id_key unique (user_id, movie_id)',
    );
    expect(migrationSql).toContain(
      'constraint calendar_tokens_user_id_key unique (user_id)',
    );
    expect(migrationSql).toContain(
      'constraint calendar_tokens_token_length_check check (char_length(token) >= 32)',
    );
  });

  it('enables RLS and scopes access to the owning user', () => {
    expect(migrationSql).toContain(
      'alter table public.watchlist_items enable row level security;',
    );
    expect(migrationSql).toContain(
      'alter table public.calendar_tokens enable row level security;',
    );
    expect(migrationSql).toContain(
      'using (auth.uid() = user_id);',
    );
    expect(migrationSql).toContain(
      'with check (auth.uid() = user_id);',
    );
  });

  it('documents the intended security boundary for later auth work', () => {
    expect(migrationSql).toContain('-- Policy intent:');
    expect(migrationSql).toContain(
      'feed should resolve tokens through server-side access',
    );
  });
});
