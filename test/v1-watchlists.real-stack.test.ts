import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as list } from '../src/app/api/v1/watchlists/route';
import { GET as detail } from '../src/app/api/v1/watchlists/[watchlistId]/route';
import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import { getWatchlistDetail, listUserWatchlists } from '../src/lib/watchlist';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const options = { auth: { autoRefreshToken: false, persistSession: false } };
const roles = ['owner', 'editor', 'pending', 'outsider'] as const;
type Role = typeof roles[number];
const actors = new Map<Role, { id: string; token: string }>();
const admin = createClient<Database>(url, serviceKey, options);
let listId = '';
let movieId = 0;
const reachable = await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(3000) })
  .then(() => true, () => false);

// CI must actually exercise these probes. Local runs may skip without a stack.
describe.skipIf(!reachable && !process.env.CI)('MOV-340 disposable bearer/cookie read parity', () => {
  beforeAll(async () => {
    expect(reachable, 'real-stack requires a reachable disposable Supabase').toBe(true);
    const runId = randomUUID();
    for (const role of roles) {
      const email = `mov340-${role}-${runId}@moviecal.test`;
      const password = `Moviecal-${runId}-Aa1!`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      const id = created.data.user!.id;
      actors.set(role, { id, token: '' }); // cleanup also covers partial setup failures
      const signed = await createClient<Database>(url, anonKey, options)
        .auth.signInWithPassword({ email, password });
      expect(signed.error).toBeNull();
      actors.set(role, { id, token: signed.data.session!.access_token });
    }
    const owner = actors.get('owner')!;
    const created = await admin.from('watchlists').insert({
      owner_user_id: owner.id, kind: 'shared', name: `MOV-340 ${runId}`,
    }).select('id').single();
    expect(created.error).toBeNull();
    listId = created.data!.id;
    for (const role of ['editor', 'pending'] as const) {
      const inserted = await admin.from('watchlist_memberships').insert({
        watchlist_id: listId, user_id: actors.get(role)!.id, role: 'editor',
        accepted_at: role === 'editor' ? new Date().toISOString() : null,
      });
      expect(inserted.error).toBeNull();
    }
    const movie = await admin.from('movies').insert({
      tmdb_id: Math.floor(Math.random() * 1000000000) + 1000000000,
      title: `MOV-340 ${runId}`, release_date: '2026-09-26',
    }).select('id').single();
    expect(movie.error).toBeNull();
    movieId = movie.data!.id;
    const item = await admin.from('watchlist_items').insert({
      user_id: owner.id, watchlist_id: listId, movie_id: movieId,
    });
    expect(item.error).toBeNull();
  }, 30000);

  afterAll(async () => {
    if (listId) expect((await admin.from('watchlists').delete().eq('id', listId)).error).toBeNull();
    if (movieId) expect((await admin.from('movies').delete().eq('id', movieId)).error).toBeNull();
    for (const actor of actors.values()) {
      expect((await admin.auth.admin.deleteUser(actor.id)).error).toBeNull();
    }
  });

  function request(path: string, token: string) {
    return new Request(`https://moviecal.test/api/v1/watchlists${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it.each(roles)('enforces real auth, domain and RLS read parity for %s', async (role) => {
    const actor = actors.get(role)!;
    const userClient = createClient<Database>(url, anonKey, {
      ...options, global: { headers: { Authorization: `Bearer ${actor.token}` } },
    });
    const repository = createSupabaseWatchlistRepository({ userClient, adminClient: admin });
    const cookieLists = await listUserWatchlists({ repository, userId: actor.id });
    const response = await list(request('', actor.token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.watchlists.map((w: { id: string }) => w.id).sort())
      .toEqual(cookieLists.map(w => w.id).sort());
    const allowed = role === 'owner' || role === 'editor';
    const shared = body.watchlists.find((w: { id: string }) => w.id === listId);
    if (allowed) expect(shared).toMatchObject({ role, canEdit: true });
    else expect(shared).toBeUndefined();
    const read = await detail(request(`/${listId}`, actor.token), {
      params: Promise.resolve({ watchlistId: listId }),
    });
    const direct = await userClient.from('watchlist_items').select('id').eq('watchlist_id', listId);
    expect(direct.error).toBeNull();
    expect(direct.data).toHaveLength(allowed ? 1 : 0);
    if (allowed) {
      expect(read.status).toBe(200);
      const result = await read.json();
      const cookie = await getWatchlistDetail({ actorUserId: actor.id, repository, watchlistId: listId });
      expect(result.items.map((i: { id: string }) => i.id)).toEqual(cookie.items.map(i => i.id));
      expect(result.items[0].addedAt).toMatch(/Z$/);
    } else {
      expect(read.status).toBe(404);
      expect(await read.json()).toEqual({ error: 'Watchlist not found.' });
      await expect(getWatchlistDetail({ actorUserId: actor.id, repository, watchlistId: listId }))
        .rejects.toThrow();
    }
  });

  it('rejects an invalid bearer without exposing shared metadata', async () => {
    const response = await detail(request(`/${listId}`, 'invalid-token'), {
      params: Promise.resolve({ watchlistId: listId }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized.' });
  });
});
