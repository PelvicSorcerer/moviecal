/**
 * MOV-344 — disposable real-stack proof of the bearer invite surface: owner
 * generate/rotate/revoke, editor/pending/outsider opacity, and that a raw
 * token returned by the bearer route actually resolves through the real
 * atomic `rotate_watchlist_invite_link` RPC (MOV-331).
 *
 * Requires a running local Supabase instance (`supabase start`);
 * vitest.real-stack.config.ts injects the local credentials.
 *
 * Lane: real-stack (npm run lane:real-stack)
 */

import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DELETE as revokeInvite, POST as createInvite } from
  '../src/app/api/v1/watchlists/[watchlistId]/invite/route';
import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import { acceptWatchlistInvite } from '../src/lib/watchlist';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const options = { auth: { autoRefreshToken: false, persistSession: false } };
const roles = ['owner', 'editor', 'pending', 'outsider'] as const;
type Role = typeof roles[number];
const reachable = await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(3000) })
  .then(() => true, () => false);

describe.skipIf((!reachable || !anonKey || !serviceKey) && !process.env.CI)(
  'MOV-344 disposable bearer invite lifecycle',
  () => {
    const admin = createClient<Database>(url, serviceKey, options);
    const actors = new Map<Role, { email: string; id: string; token: string }>();
    let listId = '';

    const token = (role: Role) => actors.get(role)!.token;
    const request = (method: string, bearer: string) => new Request(
      `https://moviecal.test/api/v1/watchlists/${listId}/invite`,
      { headers: { authorization: `Bearer ${bearer}` }, method },
    );
    const call = {
      create: (role: Role) => createInvite(request('POST', token(role)), {
        params: Promise.resolve({ watchlistId: listId }),
      }),
      revoke: (role: Role) => revokeInvite(request('DELETE', token(role)), {
        params: Promise.resolve({ watchlistId: listId }),
      }),
    };
    const liveLinks = async () => {
      const result = await admin.from('watchlist_invite_links')
        .select('token_hash, revoked_at').eq('watchlist_id', listId).is('revoked_at', null);
      expect(result.error).toBeNull();
      return result.data!;
    };

    beforeAll(async () => {
      expect(reachable, 'real-stack requires a reachable disposable Supabase').toBe(true);
      const runId = randomUUID();

      for (const role of roles) {
        const email = `mov344-${role}-${runId}@moviecal.test`;
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
    }, 60000);

    afterAll(async () => {
      for (const actor of actors.values()) await admin.auth.admin.deleteUser(actor.id);
    });

    beforeEach(async () => {
      const created = await admin.from('watchlists').insert({
        kind: 'shared', name: `MOV-344 ${randomUUID().slice(0, 8)}`,
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
    });

    afterEach(async () => {
      if (listId) await admin.from('watchlists').delete().eq('id', listId);
      listId = '';
    });

    it('lets the owner generate a link a second user can accept, raw token only in the response', async () => {
      const response = await call.create('owner');
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.inviteUrl).toContain('/watchlist/invite/');
      expect((await liveLinks())).toHaveLength(1);

      const rawToken = new URL(body.inviteUrl).pathname.split('/').pop()!;
      const repository = createSupabaseWatchlistRepository({ adminClient: admin, userClient: admin });
      const accepted = await acceptWatchlistInvite({
        actorUserId: actors.get('outsider')!.id, repository, token: rawToken,
      });

      expect(accepted.joined).toBe(true);
      const membership = await admin.from('watchlist_memberships')
        .select('accepted_at').eq('watchlist_id', listId).eq('user_id', actors.get('outsider')!.id)
        .maybeSingle();
      expect(membership.data?.accepted_at).not.toBeNull();
    });

    it('rotating replaces the old link atomically: the old token stops resolving', async () => {
      const first = await call.create('owner');
      const firstToken = new URL((await first.json()).inviteUrl).pathname.split('/').pop()!;

      const second = await call.create('owner');
      const secondBody = await second.json();

      expect(second.status).toBe(201);
      expect(secondBody.inviteUrl).not.toContain(firstToken);
      expect(await liveLinks()).toHaveLength(1);

      const repository = createSupabaseWatchlistRepository({ adminClient: admin, userClient: admin });
      const staleAccept = await acceptWatchlistInvite({
        actorUserId: actors.get('outsider')!.id, repository, token: firstToken,
      }).catch((error: unknown) => error);

      expect(staleAccept).toBeInstanceOf(Error);
    });

    it('revoking leaves no live link behind', async () => {
      await call.create('owner');
      expect(await liveLinks()).toHaveLength(1);

      const response = await call.revoke('owner');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ revoked: true });
      expect(await liveLinks()).toHaveLength(0);
    });

    it('refuses an editor with 403 and outsider/pending with the same 404, without rotating', async () => {
      const editorCreate = await call.create('editor');
      expect(editorCreate.status).toBe(403);

      for (const role of ['pending', 'outsider'] as const) {
        const denied = await call.create(role);
        expect(denied.status).toBe(404);
        expect(await denied.json()).toEqual({ error: 'Watchlist not found.' });
      }

      expect(await liveLinks()).toHaveLength(0);

      await call.create('owner');
      const editorRevoke = await call.revoke('editor');
      expect(editorRevoke.status).toBe(403);
      expect(await liveLinks()).toHaveLength(1);

      for (const role of ['pending', 'outsider'] as const) {
        const denied = await call.revoke(role);
        expect(denied.status).toBe(404);
      }
      expect(await liveLinks()).toHaveLength(1);
    });

    it('rejects a bearer that is invalid without leaking list metadata', async () => {
      const response = await createInvite(request('POST', 'invalid-token'), {
        params: Promise.resolve({ watchlistId: listId }),
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized.' });
    });
  },
);
