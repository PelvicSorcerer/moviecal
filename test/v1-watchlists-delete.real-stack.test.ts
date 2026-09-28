import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELETE as remove, GET as detail } from '../src/app/api/v1/watchlists/[watchlistId]/route';
import { GET as list } from '../src/app/api/v1/watchlists/route';
import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import { listCalendarWatchlistItems } from '../src/lib/watchlist';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const options = { auth: { autoRefreshToken: false, persistSession: false } };
const roles = ['owner', 'editor', 'outsider'] as const;
type Role = typeof roles[number];
const actors = new Map<Role, { id: string; token: string }>();
const admin = createClient<Database>(url, serviceKey, options);
const movieIds: number[] = [];
const tmdbIds: number[] = [];
let deletedId = '';
let retainedId = '';
let personalId = '';
const reachable = await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(3000) })
  .then(() => true, () => false);

function req(method: string, path: string, token: string) {
  return new Request(`https://moviecal.test/api/v1/watchlists${path}`, {
    headers: { authorization: `Bearer ${token}` },
    method,
  });
}

const call = (id: string, token: string) => remove(req('DELETE', `/${id}`, token), {
  params: Promise.resolve({ watchlistId: id }),
});

async function feedTmdbIds(role: Role) {
  const actor = actors.get(role)!;
  const userClient = createClient<Database>(url, anonKey, {
    ...options, global: { headers: { Authorization: `Bearer ${actor.token}` } },
  });
  const items = await listCalendarWatchlistItems({
    repository: createSupabaseWatchlistRepository({ userClient, adminClient: admin }),
    userId: actor.id,
  });
  return items.map((item) => item.movie.tmdbId);
}

async function exists(id: string) {
  const { data } = await admin.from('watchlists').select('id').eq('id', id).maybeSingle();
  return data !== null;
}

describe.skipIf(!reachable && !process.env.CI)('MOV-342 disposable bearer shared-list deletion', () => {
  beforeAll(async () => {
    expect(reachable, 'real-stack requires a reachable disposable Supabase').toBe(true);
    const runId = randomUUID();
    for (const role of roles) {
      const email = `mov342-${role}-${runId}@moviecal.test`;
      const password = `Moviecal-${runId}-Aa1!`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      const id = created.data.user!.id;
      actors.set(role, { id, token: '' });
      const signed = await createClient<Database>(url, anonKey, options)
        .auth.signInWithPassword({ email, password });
      expect(signed.error).toBeNull();
      actors.set(role, { id, token: signed.data.session!.access_token });
    }
    const owner = actors.get('owner')!;
    const personal = await admin.rpc('ensure_personal_watchlist_for_user', { target_user_id: owner.id });
    expect(personal.error).toBeNull();
    personalId = personal.data as string;
    for (const name of ['deleted', 'retained']) {
      const created = await admin.from('watchlists').insert({
        owner_user_id: owner.id, kind: 'shared', name: `MOV-342 ${name} ${runId}`,
      }).select('id').single();
      expect(created.error).toBeNull();
      if (name === 'deleted') deletedId = created.data!.id;
      else retainedId = created.data!.id;
      const member = await admin.from('watchlist_memberships').insert({
        watchlist_id: created.data!.id, user_id: actors.get('editor')!.id, role: 'editor',
        accepted_at: new Date().toISOString(),
      });
      expect(member.error).toBeNull();
    }
    const base = 1_100_000_000 + Math.floor(Math.random() * 1_000_000) * 2;
    for (const [i, tmdbId] of [base, base + 1].entries()) {
      const movie = await admin.from('movies').insert({
        tmdb_id: tmdbId, title: `MOV-342 ${i} ${runId}`, release_date: '2027-05-14',
      }).select('id').single();
      expect(movie.error).toBeNull();
      movieIds.push(movie.data!.id);
      tmdbIds.push(tmdbId);
    }
    // movie 0 is on both shared lists; movie 1 only on the list under test.
    const rows = [
      [deletedId, movieIds[0]], [deletedId, movieIds[1]], [retainedId, movieIds[0]],
    ].map(([watchlist_id, movie_id]) => ({ user_id: owner.id, watchlist_id: watchlist_id as string, movie_id: movie_id as number }));
    expect((await admin.from('watchlist_items').insert(rows)).error).toBeNull();
  }, 30000);

  afterAll(async () => {
    for (const id of [deletedId, retainedId]) {
      if (id) await admin.from('watchlists').delete().eq('id', id);
    }
    if (movieIds.length) await admin.from('movies').delete().in('id', movieIds);
    for (const actor of actors.values()) await admin.auth.admin.deleteUser(actor.id);
  });

  it('rejects an invalid bearer without changing anything', async () => {
    const response = await call(deletedId, 'invalid-token');
    expect(response.status).toBe(401);
    expect(await exists(deletedId)).toBe(true);
  });

  it.each(['editor', 'outsider'] as const)('refuses %s with 403 and changes nothing', async (role) => {
    const response = await call(deletedId, actors.get(role)!.token);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Watchlist access denied.' });
    expect(await exists(deletedId)).toBe(true);
    const items = await admin.from('watchlist_items').select('id').eq('watchlist_id', deletedId);
    expect(items.data).toHaveLength(2);
  });

  it('refuses deleting the owner personal list', async () => {
    const response = await call(personalId, actors.get('owner')!.token);
    expect(response.status).toBe(403);
    expect(await exists(personalId)).toBe(true);
  });

  it('lets the owner delete, cascading, and former members lose access and list-only events', async () => {
    expect(await feedTmdbIds('editor')).toEqual(expect.arrayContaining(tmdbIds));

    const response = await call(deletedId, actors.get('owner')!.token);
    expect(response.status).toBe(204);

    expect(await exists(deletedId)).toBe(false);
    for (const table of ['watchlist_items', 'watchlist_memberships', 'watchlist_invite_links'] as const) {
      const rows = await admin.from(table).select('id').eq('watchlist_id', deletedId);
      expect(rows.data).toEqual([]);
    }
    expect(await exists(retainedId)).toBe(true);

    const editor = actors.get('editor')!;
    const lists = await (await list(req('GET', '', editor.token))).json();
    const ids = lists.watchlists.map((w: { id: string }) => w.id);
    expect(ids).toContain(retainedId);
    expect(ids).not.toContain(deletedId);
    const read = await detail(req('GET', `/${deletedId}`, editor.token), {
      params: Promise.resolve({ watchlistId: deletedId }),
    });
    expect(read.status).toBe(404);

    const feed = await feedTmdbIds('editor');
    expect(feed).not.toContain(tmdbIds[1]);
    expect(feed).toContain(tmdbIds[0]);
  });

  it('reports a repeat delete as 404', async () => {
    const response = await call(deletedId, actors.get('owner')!.token);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Watchlist not found.' });
  });
});
