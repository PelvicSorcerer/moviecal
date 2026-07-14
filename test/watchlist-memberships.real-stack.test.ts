/**
 * Real-stack tests for watchlist membership operations not previously covered
 * by lane:real-stack: acceptInviteMembership (pending → accepted update path)
 * and removeMembershipFromWatchlist (delete path).
 *
 * Also validates the watchlist_memberships RLS DELETE and UPDATE policies via
 * the authenticated role, so schema drift that widens or narrows access is
 * caught before it reaches production.
 *
 * Lane: real-stack (npm run lane:real-stack)
 */

import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

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
  'watchlist-memberships — real-stack (requires local Supabase)',
  () => {
    const adminClient = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let ownerUserId = '';
    let ownerEmail = '';
    let ownerPassword = '';
    let memberUserId = '';
    let memberEmail = '';
    let memberPassword = '';
    let outsiderUserId = '';
    let outsiderEmail = '';
    let outsiderPassword = '';

    beforeAll(async () => {
      const runId = randomUUID().replace(/-/g, '').slice(0, 12);

      ownerEmail = `rs-wlm-owner-${runId}@moviecal.test`;
      ownerPassword = `Moviecal-${runId}-Aa1!`;
      memberEmail = `rs-wlm-member-${runId}@moviecal.test`;
      memberPassword = `Moviecal-${runId}-Bb2!`;
      outsiderEmail = `rs-wlm-outsider-${runId}@moviecal.test`;
      outsiderPassword = `Moviecal-${runId}-Cc3!`;

      const createUser = async (email: string, password: string): Promise<string> => {
        const { data, error } = await adminClient.auth.admin.createUser({
          email,
          email_confirm: true,
          password,
        });

        if (error || !data.user) {
          throw new Error(
            `real-stack: could not create disposable user ${email}: ${error?.message ?? 'no user returned'}`,
          );
        }

        return data.user.id;
      };

      [ownerUserId, memberUserId, outsiderUserId] = await Promise.all([
        createUser(ownerEmail, ownerPassword),
        createUser(memberEmail, memberPassword),
        createUser(outsiderEmail, outsiderPassword),
      ]);
    });

    afterAll(async () => {
      await Promise.all(
        [ownerUserId, memberUserId, outsiderUserId]
          .filter(Boolean)
          .map((id) => adminClient.auth.admin.deleteUser(id)),
      );
    });

    async function signInAsUserClient(email: string, password: string) {
      const anonClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await anonClient.auth.signInWithPassword({ email, password });

      if (error || !data.session?.access_token) {
        throw new Error(
          `real-stack: sign-in failed for ${email}: ${error?.message ?? 'no session'}`,
        );
      }

      return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
      });
    }

    async function createSharedWatchlist(label: string): Promise<string> {
      const { data, error } = await adminClient
        .from('watchlists')
        .insert({ owner_user_id: ownerUserId, kind: 'shared', name: `Test ${label}` })
        .select('id')
        .single();

      if (error || !data) {
        throw new Error(`real-stack: could not create shared watchlist: ${error?.message}`);
      }

      return data.id;
    }

    async function insertPendingMembership(watchlistId: string): Promise<string> {
      const { data, error } = await adminClient
        .from('watchlist_memberships')
        .insert({
          watchlist_id: watchlistId,
          user_id: memberUserId,
          role: 'editor',
          accepted_at: null,
        })
        .select('id')
        .single();

      if (error || !data) {
        throw new Error(`real-stack: could not insert pending membership: ${error?.message}`);
      }

      return data.id;
    }

    async function insertAcceptedMembership(watchlistId: string): Promise<string> {
      const { data, error } = await adminClient
        .from('watchlist_memberships')
        .insert({
          watchlist_id: watchlistId,
          user_id: memberUserId,
          role: 'editor',
          accepted_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error || !data) {
        throw new Error(`real-stack: could not insert accepted membership: ${error?.message}`);
      }

      return data.id;
    }

    describe('acceptInviteMembership — pending row: sets accepted_at to supplied value', () => {
      let watchlistId = '';

      beforeAll(async () => {
        watchlistId = await createSharedWatchlist(randomUUID().slice(0, 8));
        await insertPendingMembership(watchlistId);
      });

      afterAll(async () => {
        if (watchlistId) {
          await adminClient.from('watchlists').delete().eq('id', watchlistId);
        }
      });

      it('sets accepted_at to the caller-supplied value', async () => {
        const repository = createSupabaseWatchlistRepository({
          adminClient,
          userClient: adminClient,
        });
        const acceptedAt = new Date().toISOString();

        const result = await repository.acceptInviteMembership({
          acceptedAt,
          invitedByUserId: ownerUserId,
          userId: memberUserId,
          watchlistId,
        });

        expect(result.userId).toBe(memberUserId);
        expect(result.watchlistId).toBe(watchlistId);
        expect(result.role).toBe('editor');
        expect(new Date(result.acceptedAt).toISOString()).toBe(new Date(acceptedAt).toISOString());
      });
    });

    describe('acceptInviteMembership — already-accepted row: returns without overwriting accepted_at', () => {
      let watchlistId = '';
      let membershipId = '';

      beforeAll(async () => {
        watchlistId = await createSharedWatchlist(randomUUID().slice(0, 8));
        membershipId = await insertAcceptedMembership(watchlistId);
      });

      afterAll(async () => {
        if (watchlistId) {
          await adminClient.from('watchlists').delete().eq('id', watchlistId);
        }
      });

      it('returns the already-accepted membership without overwriting accepted_at', async () => {
        const repository = createSupabaseWatchlistRepository({
          adminClient,
          userClient: adminClient,
        });

        const { data: before } = await adminClient
          .from('watchlist_memberships')
          .select('accepted_at')
          .eq('id', membershipId)
          .single();

        const result = await repository.acceptInviteMembership({
          acceptedAt: new Date(Date.now() + 60_000).toISOString(),
          invitedByUserId: ownerUserId,
          userId: memberUserId,
          watchlistId,
        });

        expect(result.acceptedAt).toBe(before?.accepted_at);
      });
    });

    describe('removeMembershipFromWatchlist — delete via adminClient', () => {
      let watchlistId = '';

      beforeAll(async () => {
        watchlistId = await createSharedWatchlist(randomUUID().slice(0, 8));
      });

      afterAll(async () => {
        if (watchlistId) {
          await adminClient.from('watchlists').delete().eq('id', watchlistId);
        }
      });

      it('removes an existing membership row and returns true', async () => {
        const membershipId = await insertAcceptedMembership(watchlistId);
        const repository = createSupabaseWatchlistRepository({
          adminClient,
          userClient: adminClient,
        });

        const removed = await repository.removeMembershipFromWatchlist(watchlistId, membershipId);

        expect(removed).toBe(true);

        const { data } = await adminClient
          .from('watchlist_memberships')
          .select('id')
          .eq('id', membershipId)
          .maybeSingle();

        expect(data).toBeNull();
      });

      it('returns false when the membership row does not exist', async () => {
        const repository = createSupabaseWatchlistRepository({
          adminClient,
          userClient: adminClient,
        });

        const removed = await repository.removeMembershipFromWatchlist(watchlistId, randomUUID());

        expect(removed).toBe(false);
      });
    });

    describe('watchlist_memberships RLS — DELETE policy', () => {
      let watchlistId = '';
      let membershipId = '';

      beforeEach(async () => {
        watchlistId = await createSharedWatchlist(randomUUID().slice(0, 8));
        membershipId = await insertAcceptedMembership(watchlistId);
      });

      afterEach(async () => {
        if (watchlistId) {
          await adminClient.from('watchlists').delete().eq('id', watchlistId);
        }
      });

      it('allows the watchlist owner to delete a membership row via authenticated role', async () => {
        const ownerClient = await signInAsUserClient(ownerEmail, ownerPassword);

        const { error } = await ownerClient
          .from('watchlist_memberships')
          .delete()
          .eq('id', membershipId)
          .eq('watchlist_id', watchlistId);

        expect(error).toBeNull();

        const { data } = await adminClient
          .from('watchlist_memberships')
          .select('id')
          .eq('id', membershipId)
          .maybeSingle();

        expect(data).toBeNull();
      });

      it('prevents an outsider from deleting a membership row via authenticated role', async () => {
        const outsiderClient = await signInAsUserClient(outsiderEmail, outsiderPassword);

        const { error } = await outsiderClient
          .from('watchlist_memberships')
          .delete()
          .eq('id', membershipId)
          .eq('watchlist_id', watchlistId);

        // RLS silently filters the row — no error, but the row is untouched
        expect(error).toBeNull();

        const { data } = await adminClient
          .from('watchlist_memberships')
          .select('id')
          .eq('id', membershipId)
          .maybeSingle();

        expect(data).not.toBeNull();
      });

      it('prevents the member from deleting their own membership row via authenticated role', async () => {
        const memberClient = await signInAsUserClient(memberEmail, memberPassword);

        const { error } = await memberClient
          .from('watchlist_memberships')
          .delete()
          .eq('id', membershipId)
          .eq('watchlist_id', watchlistId);

        // Current DELETE policy restricts to watchlist owner only
        expect(error).toBeNull();

        const { data } = await adminClient
          .from('watchlist_memberships')
          .select('id')
          .eq('id', membershipId)
          .maybeSingle();

        expect(data).not.toBeNull();
      });
    });

    describe('watchlist_memberships RLS — UPDATE policy', () => {
      let watchlistId = '';
      let membershipId = '';

      beforeEach(async () => {
        watchlistId = await createSharedWatchlist(randomUUID().slice(0, 8));
        membershipId = await insertPendingMembership(watchlistId);
      });

      afterEach(async () => {
        if (watchlistId) {
          await adminClient.from('watchlists').delete().eq('id', watchlistId);
        }
      });

      it('allows the watchlist owner to update a membership row via authenticated role', async () => {
        const ownerClient = await signInAsUserClient(ownerEmail, ownerPassword);
        const acceptedAt = new Date().toISOString();

        const { data, error } = await ownerClient
          .from('watchlist_memberships')
          .update({ accepted_at: acceptedAt, role: 'editor' })
          .eq('id', membershipId)
          .eq('watchlist_id', watchlistId)
          .select('id, accepted_at')
          .single();

        expect(error).toBeNull();
        expect(new Date(data?.accepted_at).toISOString()).toBe(new Date(acceptedAt).toISOString());
      });

      it('prevents the invite recipient from accepting their own membership via authenticated role', async () => {
        const memberClient = await signInAsUserClient(memberEmail, memberPassword);

        const { data, error } = await memberClient
          .from('watchlist_memberships')
          .update({ accepted_at: new Date().toISOString(), role: 'editor' })
          .eq('id', membershipId)
          .eq('watchlist_id', watchlistId)
          .select('id');

        // Current UPDATE policy restricts to watchlist owner only
        expect(error).toBeNull();
        expect(data).toHaveLength(0);
      });
    });
  },
);
