/**
 * Migration ordering guard.
 *
 * MOV-330's invariant migration must apply strictly after the migrations it
 * depends on: 20260625150000 creates the objects it rewrites, and 20260710000000
 * issues the `authenticated` grants it narrows to a single column. Supabase
 * applies migrations in filename order, so a filename that sorts earlier — or a
 * duplicated timestamp — would silently change what this migration runs against.
 *
 * Lane: unit (npm run lane:unit)
 */

import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migrations = readdirSync('supabase/migrations')
  .filter((filename) => filename.endsWith('.sql'))
  .sort();

describe('Supabase migration ordering', () => {
  it('applies the MOV-330 invariants last, on unique timestamps', () => {
    const timestamps = migrations.map((filename) => filename.split('_')[0]);

    expect(migrations.at(-1)).toBe(
      '20260924000000_mov_330_watchlist_ownership_invariants.sql',
    );
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });
});
