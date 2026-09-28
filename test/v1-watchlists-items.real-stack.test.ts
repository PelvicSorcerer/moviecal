import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as add } from '../src/app/api/v1/watchlists/[watchlistId]/items/route';
import { DELETE as remove } from '../src/app/api/v1/watchlists/[watchlistId]/items/[itemId]/route';
import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import { addWatchlistItem, removeWatchlistItem } from '../src/lib/watchlist';

const tmdbId = Math.floor(Math.random() * 1000000000) + 1000000000;

vi.mock('../src/lib/tmdb/client', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tmdb/client')>(
    '../src/lib/tmdb/client',
  );

  return {
    ...actual,
    getMovieDetails: async (id: number) => ({
      overview: null,
      posterPath: null,
      rawJson: { id },
      releaseDate: '2026-09-26',
      title: `MOV-343 ${id}`,
      tmdbId: id,
    }),
  };
});

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const options = { auth: { autoRefreshToken: false, persistSession: false } };
const roles = ['owner', 'editor', 'pending', 'outsider'] as const;
type Role = typeof roles[number];
const actors = new Map<Role, { id: string; token: string }>();
const admin = createClient<Database>(url, serviceKey, options);
let listId = '';
const reachable = await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(3000) })
  .then(() => true, () => false);

async function countItems(): Promise<number> {
  const rows = await admin.from('watchlist_items').select('id').eq('watchlist_id', listId);
  expect(rows.error).toBeNull();

  return rows.data!.length;
}

function call(method: string, token: string, body?: unknown) {
  return new Request('https://moviecal.test/api/v1/watchlists/x/items', {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method,
  });
}

function webRepository(role: Role) {
  const userClient = createClient<Database>(url, anonKey, {
    ...options, global: { headers: { Authorization: `Bearer ${actors.get(role)!.token}` } },
  });

  return createSupabaseWatchlistRepository({ userClient, adminClient: admin });
}

// CI must actually exercise these probes. Local runs may skip without a stack.
describe.skipIf(!reachable && !process.env.CI)('MOV-343 disposable bearer/web item write parity', () => {
  beforeAll(async () => {
    expect(reachable, 'real-stack requires a reachable disposable Supabase').toBe(true);
    const runId = randomUUID();
    for (const role of roles) {
      const email = `mov343-${role}-${runId}@moviecal.test`;
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
    const created = await admin.from('watchlists').insert({
      owner_user_id: actors.get('owner')!.id, kind: 'shared', name: `MOV-343 ${runId}`,
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
  }, 30000);

  afterAll(async () => {
    if (listId) expect((await admin.from('watchlists').delete().eq('id', listId)).error).toBeNull();
    expect((await admin.from('movies').delete().eq('tmdb_id', tmdbId)).error).toBeNull();
    for (const actor of actors.values()) {
      expect((await admin.auth.admin.deleteUser(actor.id)).error).toBeNull();
    }
  });

  const params = (itemId?: string) => ({ params: Promise.resolve({ itemId: itemId!, watchlistId: listId }) });

  it.each(['pending', 'outsider'] as const)('rejects %s add and remove on bearer and web alike', async (role) => {
    const token = actors.get(role)!.token;
    const response = await add(call('POST', token, { tmdbId }), params());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Watchlist not found.' });
    await expect(addWatchlistItem({
      actorUserId: actors.get(role)!.id,
      getMovieDetails: async () => { throw new Error('unreachable'); },
      repository: webRepository(role),
      tmdbId,
      watchlistId: listId,
    })).rejects.toThrow();
    expect((await remove(call('DELETE', token), params('nope'))).status).toBe(404);
    expect(await countItems()).toBe(0);
  });

  it('lets owner and editor add idempotently and remove, sharing one item across transports', async () => {
    const owner = actors.get('owner')!;
    const editor = actors.get('editor')!;
    const first = await add(call('POST', owner.token, { tmdbId }), params());
    const retry = await add(call('POST', editor.token, { tmdbId }), params());
    const firstBody = await first.json();

    expect([first.status, retry.status]).toEqual([201, 200]);
    expect((await retry.json()).item.id).toBe(firstBody.item.id);
    expect(await countItems()).toBe(1);

    const web = await addWatchlistItem({
      actorUserId: editor.id,
      getMovieDetails: async (id) => ({
        overview: null, posterPath: null, rawJson: { id }, releaseDate: '2026-09-26',
        title: `MOV-343 ${id}`, tmdbId: id,
      }),
      repository: webRepository('editor'),
      tmdbId,
      watchlistId: listId,
    });

    expect(web).toMatchObject({ created: false, item: { id: firstBody.item.id } });
    expect((await remove(call('DELETE', editor.token), params(firstBody.item.id))).status).toBe(204);
    expect((await remove(call('DELETE', owner.token), params(firstBody.item.id))).status).toBe(404);
    await expect(removeWatchlistItem({
      actorUserId: owner.id, itemId: firstBody.item.id, repository: webRepository('owner'), watchlistId: listId,
    })).rejects.toThrow('Watchlist item not found.');
    expect(await countItems()).toBe(0);
  });
});
