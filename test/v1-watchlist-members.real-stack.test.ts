/**
 * MOV-346 — disposable real-stack proof of the bearer member surface: owner
 * list/removal, editor leave, owner protection, outsider/pending opacity, and
 * loss of access and private calendar contribution on the next request.
 *
 * Requires a running local Supabase instance (`supabase start`);
 * vitest.real-stack.config.ts injects the local credentials.
 *
 * Lane: real-stack (npm run lane:real-stack)
 */

import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as detail } from '../src/app/api/v1/watchlists/[watchlistId]/route';
import { GET as listMembers } from '../src/app/api/v1/watchlists/[watchlistId]/members/route';
import { DELETE as removeMember } from '../src/app/api/v1/watchlists/[watchlistId]/members/[membershipId]/route';
import { DELETE as leave } from '../src/app/api/v1/watchlists/[watchlistId]/membership/route';
import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import { listCalendarWatchlistItems } from '../src/lib/watchlist';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const options = { auth: { autoRefreshToken: false, persistSession: false } };
const roles = ['owner', 'editor', 'pending', 'outsider'] as const;
type Role = typeof roles[number];
const reachable = await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(3000) })
  .then(() => true, () => false);

describe.skipIf((!reachable || !anonKey || !serviceKey) && !process.env.CI)(
  'MOV-346 disposable bearer member management',
  () => {
    const admin = createClient<Database>(url, serviceKey, options);
    const actors = new Map<Role, { email: string; id: string; token: string }>();
    let movieId = 0;
    let listId = '';

    const token = (role: Role) => actors.get(role)!.token;
    const membershipId = async (role: Role) => (await admin.from('watchlist_memberships')
      .select('id').eq('watchlist_id', listId).eq('user_id', actors.get(role)!.id)
      .maybeSingle()).data?.id ?? null;
    const request = (method: string, path: string, bearer: string) => new Request(
      `https://moviecal.test/api/v1/watchlists/${listId}${path}`,
      { headers: { authorization: `Bearer ${bearer}` }, method },
    );
    const call = {
      detail: (role: Role) => detail(request('GET', '', token(role)), {
        params: Promise.resolve({ watchlistId: listId }),
      }),
      leave: (role: Role) => leave(request('DELETE', '/membership', token(role)), {
        params: Promise.resolve({ watchlistId: listId }),
      }),
      list: (role: Role) => listMembers(request('GET', '/members', token(role)), {
        params: Promise.resolve({ watchlistId: listId }),
      }),
      remove: (role: Role, id: string) => removeMember(
        request('DELETE', `/members/${id}`, token(role)),
        { params: Promise.resolve({ membershipId: id, watchlistId: listId }) },
      ),
    };
    const feedFor = async (role: Role) => (await listCalendarWatchlistItems({
      repository: createSupabaseWatchlistRepository({ adminClient: admin, userClient: admin }),
      userId: actors.get(role)!.id,
    })).map((item) => item.movie.id);

    beforeAll(async () => {
      expect(reachable, 'real-stack requires a reachable disposable Supabase').toBe(true);
      const runId = randomUUID();

      for (const role of roles) {
        const email = `mov346-${role}-${runId}@moviecal.test`;
        const password = `Moviecal-${runId}-Aa1!`;
        const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        expect(created.error).toBeNull();
        const id = created.data.user!.id;
        actors.set(role, { email, id, token: '' }); // cleanup covers partial setup
        const signed = await createClient<Database>(url, anonKey, options)
          .auth.signInWithPassword({ email, password });
        expect(signed.error).toBeNull();
        actors.set(role, { email, id, token: signed.data.session!.access_token });
      }

      const movie = await admin.from('movies').insert({
        tmdb_id: 900_000_000 + parseInt(randomUUID().replace(/-/g, '').slice(0, 6), 16),
        title: `MOV-346 ${runId}`, release_date: '2026-10-01', raw_json: {},
      }).select('id').single();
      expect(movie.error).toBeNull();
      movieId = movie.data!.id;
    }, 60000);

    afterAll(async () => {
      if (movieId) await admin.from('movies').delete().eq('id', movieId);
      for (const actor of actors.values()) await admin.auth.admin.deleteUser(actor.id);
    });

    beforeEach(async () => {
      const created = await admin.from('watchlists').insert({
        kind: 'shared', name: `MOV-346 ${randomUUID().slice(0, 8)}`,
        owner_user_id: actors.get('owner')!.id,
      }).select('id').single();
      expect(created.error).toBeNull();
      listId = created.data!.id;

      for (const role of ['editor', 'pending'] as const) {
        const inserted = await admin.from('watchlist_memberships').insert({
          accepted_at: role === 'editor' ? new Date().toISOString() : null,
          invited_by_user_id: actors.get('owner')!.id,
          role: 'editor', user_id: actors.get(role)!.id, watchlist_id: listId,
        });
        expect(inserted.error).toBeNull();
      }

      const item = await admin.from('watchlist_items').insert({ movie_id: movieId, watchlist_id: listId });
      expect(item.error).toBeNull();
    });

    afterEach(async () => {
      if (listId) await admin.from('watchlists').delete().eq('id', listId);
      listId = '';
    });

    it.each(['leave', 'remove'] as const)(
      'editor %s ends detail access and calendar contribution on the next request',
      async (operation) => {
        expect((await call.detail('editor')).status).toBe(200);
        expect(await feedFor('editor')).toContain(movieId);
        expect(await feedFor('owner')).toContain(movieId);

        const response = operation === 'leave'
          ? await call.leave('editor')
          : await call.remove('owner', (await membershipId('editor'))!);

        expect(response.status).toBe(200);
        expect(await membershipId('editor')).toBeNull();
        expect((await call.detail('editor')).status).toBe(404);
        expect((await call.list('editor')).status).toBe(404);
        expect(await feedFor('editor')).not.toContain(movieId);
        // The owner's own access and calendar contribution are untouched.
        expect((await call.detail('owner')).status).toBe(200);
        expect(await feedFor('owner')).toContain(movieId);
      },
    );

    it('lists members with emails to the owner only', async () => {
      const response = await call.list('owner');
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.members.map((m: { email: string }) => m.email).sort()).toEqual(
        ['owner', 'editor', 'pending'].map((role) => actors.get(role as Role)!.email).sort(),
      );
      const ownerRow = body.members.find((m: { role: string }) => m.role === 'owner');
      expect(ownerRow.id).toBe(`owner:${actors.get('owner')!.id}`);

      const editor = await call.list('editor');
      expect(editor.status).toBe(403);
      expect(JSON.stringify(await editor.json())).not.toContain('@moviecal.test');

      for (const role of ['pending', 'outsider'] as const) {
        const denied = await call.list(role);
        expect(denied.status).toBe(404);
        expect(await denied.json()).toEqual({ error: 'Watchlist not found.' });
      }
    });

    it('refuses owner removal/leave and outsider mutations without changing data', async () => {
      const ownerMembership = (await membershipId('owner'))!;
      const editorMembership = (await membershipId('editor'))!;
      const before = await admin.from('watchlist_memberships').select('id').eq('watchlist_id', listId);

      expect((await call.leave('owner')).status).toBe(403);
      expect((await call.remove('owner', ownerMembership)).status).toBe(403);
      expect((await call.remove('owner', `owner:${actors.get('owner')!.id}`)).status).toBe(404);
      expect((await call.remove('editor', editorMembership)).status).toBe(403);
      expect((await call.remove('editor', ownerMembership)).status).toBe(403);

      for (const role of ['pending', 'outsider'] as const) {
        expect((await call.remove(role, editorMembership)).status).toBe(404);
        expect((await call.leave(role)).status).toBe(404);
      }

      const after = await admin.from('watchlist_memberships').select('id').eq('watchlist_id', listId);

      expect(after.data?.map((row) => row.id).sort()).toEqual(before.data?.map((row) => row.id).sort());
      expect((await call.detail('owner')).status).toBe(200);
    });

    it('rejects a bearer that is invalid without leaking list metadata', async () => {
      const response = await removeMember(request('DELETE', '/members/x', 'invalid-token'), {
        params: Promise.resolve({ membershipId: 'x', watchlistId: listId }),
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized.' });
    });
  },
);
