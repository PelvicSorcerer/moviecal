/**
 * MOV-330 — disposable real-stack probes for the watchlist ownership,
 * personal-list, and editor-name invariants added by migration
 * 20260924000000_mov_330_watchlist_ownership_invariants.sql.
 *
 * Every probe runs as a real Supabase role: `owner`, `editor` (accepted
 * membership), `pending` (membership with a null accepted_at), `outsider` (no
 * relationship), and the server-only service role. Everything created here is
 * disposable and removed in afterAll by deleting the auth user, which is also
 * the only path allowed to remove a personal watchlist.
 *
 * Lane: real-stack (npm run lane:real-stack)
 */

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/lib/supabase/database';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const BASELINE_NAME = 'MOV-330 invariant probe';
const NON_OWNERS = ['editor', 'outsider', 'pending'] as const;

type Client = SupabaseClient<Database>;

/** Unwraps a seeding response, failing the run loudly rather than mid-probe. */
function seeded<T>(
  response: { data: T | null; error: { message: string } | null },
  what: string,
): T {
  if (response.error || response.data === null) {
    throw new Error(`real-stack: could not seed the ${what}: ${response.error?.message}`);
  }

  return response.data;
}

async function isSupabaseReachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(3000) });

    return true;
  } catch {
    return false;
  }
}

const supabaseReachable = await isSupabaseReachable(SUPABASE_URL);
const credentialsPresent = Boolean(SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!supabaseReachable || !credentialsPresent)(
  'watchlist ownership invariants — real-stack (requires local Supabase)',
  () => {
    const adminClient = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const credentials: Record<string, { email: string; password: string }> = {};
    const userIds: Record<string, string> = {};
    const clients: Record<string, Client> = {};

    let sharedId = '';
    let personalId = '';
    let ownerMembershipId = '';
    let editorMembershipId = '';
    let pendingMembershipId = '';

    async function createUser(label: string): Promise<string> {
      const runId = randomUUID().replace(/-/g, '').slice(0, 12);
      const email = `rs-mov330-${label}-${runId}@moviecal.test`;
      const password = `Moviecal-${runId}-Aa1!`;
      const { data, error } = await adminClient.auth.admin.createUser({
        email,
        email_confirm: true,
        password,
      });

      if (error || !data.user) {
        throw new Error(`real-stack: could not create ${label}: ${error?.message}`);
      }

      credentials[label] = { email, password };
      userIds[label] = data.user.id;

      return data.user.id;
    }

    async function signIn(label: string): Promise<Client> {
      const anonClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await anonClient.auth.signInWithPassword(
        credentials[label],
      );

      if (error || !data.session?.access_token) {
        throw new Error(`real-stack: sign-in failed for ${label}: ${error?.message}`);
      }

      return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
      });
    }

    async function watchlistRow(id: string) {
      const { data } = await adminClient
        .from('watchlists')
        .select('id, kind, name, owner_user_id')
        .eq('id', id)
        .maybeSingle();

      return data;
    }

    async function membershipRow(id: string) {
      const { data } = await adminClient
        .from('watchlist_memberships')
        .select('id, accepted_at, role, user_id, watchlist_id')
        .eq('id', id)
        .maybeSingle();

      return data;
    }

    beforeAll(async () => {
      for (const label of ['owner', 'editor', 'pending', 'outsider']) {
        await createUser(label);
        clients[label] = await signIn(label);
      }

      personalId = seeded(
        await adminClient.rpc('ensure_personal_watchlist_for_user', {
          target_user_id: userIds.owner,
        }),
        'personal watchlist',
      );

      sharedId = seeded(
        await adminClient
          .from('watchlists')
          .insert({ kind: 'shared', name: BASELINE_NAME, owner_user_id: userIds.owner })
          .select('id')
          .single(),
        'shared watchlist',
      ).id;

      // The insert trigger from 20260625150000 is what creates this row.
      ownerMembershipId = seeded(
        await adminClient
          .from('watchlist_memberships')
          .select('id')
          .eq('watchlist_id', sharedId)
          .eq('user_id', userIds.owner)
          .single(),
        'owner membership',
      ).id;

      const rows = seeded(
        await adminClient
          .from('watchlist_memberships')
          .insert([
            {
              accepted_at: new Date().toISOString(),
              role: 'editor',
              user_id: userIds.editor,
              watchlist_id: sharedId,
            },
            {
              accepted_at: null,
              role: 'editor',
              user_id: userIds.pending,
              watchlist_id: sharedId,
            },
          ])
          .select('id, user_id'),
        'memberships',
      );

      editorMembershipId = rows.find((row) => row.user_id === userIds.editor)!.id;
      pendingMembershipId = rows.find((row) => row.user_id === userIds.pending)!.id;
    });

    afterAll(async () => {
      await Promise.all(
        Object.values(userIds).map((id) => adminClient.auth.admin.deleteUser(id)),
      );
    });

    describe('the real owner membership is permanent', () => {
      it('refuses every delete of the owner membership and leaves the row in place', async () => {
        const ownerAttempt = await clients.owner
          .from('watchlist_memberships')
          .delete()
          .eq('id', ownerMembershipId);
        const serviceAttempt = await adminClient
          .from('watchlist_memberships')
          .delete()
          .eq('id', ownerMembershipId);

        // RLS lets the owner reach the row, so the trigger is what refuses.
        expect(ownerAttempt.error).not.toBeNull();
        expect(serviceAttempt.error).not.toBeNull();
        expect(await membershipRow(ownerMembershipId)).not.toBeNull();
      });

      it('refuses demoting or un-accepting the owner membership', async () => {
        const ownerDemotion = await clients.owner
          .from('watchlist_memberships')
          .update({ role: 'editor' })
          .eq('id', ownerMembershipId);
        const demotion = await adminClient
          .from('watchlist_memberships')
          .update({ role: 'editor' })
          .eq('id', ownerMembershipId);
        const unaccept = await adminClient
          .from('watchlist_memberships')
          .update({ accepted_at: null })
          .eq('id', ownerMembershipId);
        const row = await membershipRow(ownerMembershipId);

        expect(ownerDemotion.error).not.toBeNull();
        expect(demotion.error).not.toBeNull();
        expect(unaccept.error).not.toBeNull();
        expect(row?.role).toBe('owner');
        expect(row?.accepted_at).not.toBeNull();
      });

      it('refuses reassigning the owner membership to another user', async () => {
        const { error } = await adminClient
          .from('watchlist_memberships')
          .update({ user_id: userIds.editor })
          .eq('id', ownerMembershipId);

        expect(error).not.toBeNull();
        expect((await membershipRow(ownerMembershipId))?.user_id).toBe(userIds.owner);
      });

      it('refuses granting the owner role to a non-owner membership', async () => {
        const { error } = await adminClient
          .from('watchlist_memberships')
          .update({ role: 'owner' })
          .eq('id', editorMembershipId);

        expect(error).not.toBeNull();
        expect((await membershipRow(editorMembershipId))?.role).toBe('editor');
      });

      it.each(NON_OWNERS)(
        'silently filters a %s delete attempt on the owner membership',
        async (label) => {
          const { error } = await clients[label]
            .from('watchlist_memberships')
            .delete()
            .eq('id', ownerMembershipId);

          expect(error).toBeNull();
          expect(await membershipRow(ownerMembershipId)).not.toBeNull();
        },
      );
    });

    describe('owner_user_id and kind are immutable', () => {
      // For `owner` and `editor` the refusal comes from the column grant, which
      // Postgres checks before RLS or the trigger; for the service role, which
      // bypasses both, the trigger is what refuses.
      it.each(['owner', 'editor', 'service'] as const)(
        'refuses an ownership or kind change by %s',
        async (label) => {
          const client = label === 'service' ? adminClient : clients[label];
          const ownerChange = await client
            .from('watchlists')
            .update({ owner_user_id: userIds.editor })
            .eq('id', sharedId);
          const kindChange = await client
            .from('watchlists')
            .update({ kind: 'personal' })
            .eq('id', sharedId);
          const row = await watchlistRow(sharedId);

          expect(ownerChange.error).not.toBeNull();
          expect(kindChange.error).not.toBeNull();
          expect(row?.owner_user_id).toBe(userIds.owner);
          expect(row?.kind).toBe('shared');
        },
      );
    });

    describe('personal watchlists cannot be deleted', () => {
      it('filters an owner-authenticated delete and refuses a service-role delete', async () => {
        const ownerAttempt = await clients.owner
          .from('watchlists')
          .delete()
          .eq('id', personalId);

        expect(ownerAttempt.error).toBeNull();
        expect(await watchlistRow(personalId)).not.toBeNull();

        const serviceAttempt = await adminClient
          .from('watchlists')
          .delete()
          .eq('id', personalId);

        expect(serviceAttempt.error).not.toBeNull();
        expect(await watchlistRow(personalId)).not.toBeNull();
      });

      it('still deletes a shared watchlist and cascades its memberships', async () => {
        const created = await adminClient
          .from('watchlists')
          .insert({
            kind: 'shared',
            name: 'MOV-330 disposable shared list',
            owner_user_id: userIds.owner,
          })
          .select('id')
          .single();

        expect(created.error).toBeNull();

        const { error } = await adminClient
          .from('watchlists')
          .delete()
          .eq('id', created.data!.id);
        const { data: orphans } = await adminClient
          .from('watchlist_memberships')
          .select('id')
          .eq('watchlist_id', created.data!.id);

        expect(error).toBeNull();
        expect(await watchlistRow(created.data!.id)).toBeNull();
        expect(orphans).toEqual([]);
      });
    });

    describe('accepted editors may update only a shared watchlist name', () => {
      beforeEach(async () => {
        await adminClient
          .from('watchlists')
          .update({ name: BASELINE_NAME })
          .eq('id', sharedId);
      });

      it('lets an accepted editor rename the shared watchlist', async () => {
        const { error } = await clients.editor
          .from('watchlists')
          .update({ name: 'Renamed by an editor' })
          .eq('id', sharedId);

        expect(error).toBeNull();
        expect((await watchlistRow(sharedId))?.name).toBe('Renamed by an editor');
      });

      it.each(['outsider', 'pending'] as const)(
        'leaves the name unchanged for %s',
        async (label) => {
          const { data, error } = await clients[label]
            .from('watchlists')
            .update({ name: `Renamed by ${label}` })
            .eq('id', sharedId)
            .select('id');

          expect(error).toBeNull();
          expect(data).toEqual([]);
          expect((await watchlistRow(sharedId))?.name).toBe(BASELINE_NAME);
        },
      );
    });

    describe('private metadata stays hidden', () => {
      it.each(['outsider', 'pending'] as const)(
        'returns no watchlist or membership rows to %s',
        async (label) => {
          const watchlists = await clients[label]
            .from('watchlists')
            .select('id, name, owner_user_id')
            .eq('id', sharedId);
          const memberships = await clients[label]
            .from('watchlist_memberships')
            .select('id, user_id, role')
            .eq('watchlist_id', sharedId)
            .neq('user_id', userIds[label]);

          expect(watchlists.error).toBeNull();
          expect(watchlists.data).toEqual([]);
          expect(memberships.error).toBeNull();
          expect(memberships.data).toEqual([]);
        },
      );

      it('does not reveal another user's ownership or membership through RPCs', async () => {
        const probes = await Promise.all([
          clients.outsider.rpc('is_watchlist_owner', {
            target_user_id: userIds.owner,
            target_watchlist_id: sharedId,
          }),
          clients.outsider.rpc('is_active_watchlist_member', {
            target_user_id: userIds.editor,
            target_watchlist_id: sharedId,
          }),
          clients.pending.rpc('can_edit_watchlist', {
            target_user_id: userIds.editor,
            target_watchlist_id: sharedId,
          }),
        ]);

        for (const probe of probes) {
          expect(probe.error).toBeNull();
          expect(probe.data).toBe(false);
        }

        const self = await clients.editor.rpc('can_edit_watchlist', {
          target_user_id: userIds.editor,
          target_watchlist_id: sharedId,
        });

        expect(self.error).toBeNull();
        expect(self.data).toBe(true);
      });

      it('keeps a pending invitee outside the edit boundary until acceptance', async () => {
        const accepted = await clients.editor.rpc('is_active_watchlist_member', {
          target_user_id: userIds.editor,
          target_watchlist_id: sharedId,
        });
        const pending = await clients.pending.rpc('can_edit_watchlist', {
          target_user_id: userIds.pending,
          target_watchlist_id: sharedId,
        });

        expect(accepted.data).toBe(true);
        expect(pending.data).toBe(false);
        expect((await membershipRow(pendingMembershipId))?.accepted_at).toBeNull();
      });
    });

    describe('ensure_personal_watchlist_for_user is caller-scoped', () => {
      it('refuses an authenticated call for another user and creates nothing', async () => {
        const strangerId = await createUser('stranger');
        const { error } = await clients.outsider.rpc(
          'ensure_personal_watchlist_for_user',
          { target_user_id: strangerId },
        );
        const { data } = await adminClient
          .from('watchlists')
          .select('id')
          .eq('owner_user_id', strangerId)
          .eq('kind', 'personal');

        expect(error).not.toBeNull();
        expect(data).toEqual([]);
      });

      it('allows the caller for themselves and the service role for anyone', async () => {
        const self = await clients.outsider.rpc('ensure_personal_watchlist_for_user', {
          target_user_id: userIds.outsider,
        });
        const server = await adminClient.rpc('ensure_personal_watchlist_for_user', {
          target_user_id: userIds.editor,
        });

        expect(self.error).toBeNull();
        expect(typeof self.data).toBe('string');
        expect(server.error).toBeNull();
        expect(typeof server.data).toBe('string');
      });
    });

    it('still cascades an account deletion through every guard', async () => {
      const departingId = await createUser('departing');
      const personal = await adminClient.rpc('ensure_personal_watchlist_for_user', {
        target_user_id: departingId,
      });
      const membership = await adminClient
        .from('watchlist_memberships')
        .insert({
          accepted_at: new Date().toISOString(),
          role: 'editor',
          user_id: departingId,
          watchlist_id: sharedId,
        });

      expect(personal.error).toBeNull();
      expect(membership.error).toBeNull();

      const { error } = await adminClient.auth.admin.deleteUser(departingId);

      delete userIds.departing;

      const { data: remaining } = await adminClient
        .from('watchlist_memberships')
        .select('id')
        .eq('user_id', departingId);

      expect(error).toBeNull();
      expect(await watchlistRow(personal.data as string)).toBeNull();
      expect(remaining).toEqual([]);
    });
  },
);
