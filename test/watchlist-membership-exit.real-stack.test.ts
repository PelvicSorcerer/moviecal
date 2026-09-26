/**
 * MOV-374 — two-account real-stack proof of the shared membership-exit
 * contract: editor self-leave, owner-only removal, owner protection against
 * both a crafted membership id and a direct service-role delete, owner-only
 * member-email visibility, access and calendar loss on the next request, and
 * rejoin only through a still-valid invite.
 *
 * Requires a running local Supabase instance (`supabase start`);
 * vitest.real-stack.config.ts injects the local credentials. Every account,
 * watchlist, and movie row it creates is disposable and removed afterwards.
 *
 * Lane: real-stack (npm run lane:real-stack)
 */

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import {
  acceptWatchlistInvite,
  addWatchlistItem,
  createSharedWatchlist,
  createSharedWatchlistInviteLink,
  getWatchlistDetail,
  leaveSharedWatchlist,
  listCalendarWatchlistItems,
  listSharedWatchlistMemberProfiles,
  listUserWatchlists,
  removeSharedWatchlistMember,
  type WatchlistRepository,
} from '../src/lib/watchlist';

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
  'shared watchlist membership exit — real-stack (requires local Supabase)',
  () => {
    const adminClient = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    interface DisposableAccount {
      email: string;
      password: string;
      userId: string;
    }

    let owner: DisposableAccount;
    let editor: DisposableAccount;
    let outsider: DisposableAccount;
    let movieId = 0;

    let ownerRepository: WatchlistRepository;
    let editorRepository: WatchlistRepository;
    let outsiderRepository: WatchlistRepository;

    const clients = new Map<string, SupabaseClient<Database>>();
    const feedRepository = createSupabaseWatchlistRepository({ adminClient, userClient: adminClient });

    let watchlistId = '';
    let inviteToken = '';

    async function createAccount(label: string): Promise<DisposableAccount> {
      const runId = randomUUID().replace(/-/g, '').slice(0, 12);
      const email = `rs-exit-${label}-${runId}@moviecal.test`;
      const password = `Moviecal-${runId}-Aa1!`;
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

      return { email, password, userId: data.user.id };
    }

    async function repositoryFor(account: DisposableAccount): Promise<WatchlistRepository> {
      const anonClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await anonClient.auth.signInWithPassword({
        email: account.email,
        password: account.password,
      });

      if (error || !data.session?.access_token) {
        throw new Error(
          `real-stack: sign-in failed for ${account.email}: ${error?.message ?? 'no session'}`,
        );
      }

      const userClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: {
          headers: { Authorization: `Bearer ${data.session.access_token}` },
        },
      });

      clients.set(account.userId, userClient);
      return createSupabaseWatchlistRepository({ adminClient, userClient });
    }

    async function membershipIdFor(userId: string): Promise<string | null> {
      const { data, error } = await adminClient
        .from('watchlist_memberships')
        .select('id')
        .eq('watchlist_id', watchlistId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) throw new Error(`real-stack: membership lookup failed: ${error.message}`);
      return data?.id ?? null;
    }

    beforeAll(async () => {
      owner = await createAccount('owner');
      editor = await createAccount('editor');
      outsider = await createAccount('outsider');

      [ownerRepository, editorRepository, outsiderRepository] = await Promise.all([
        repositoryFor(owner),
        repositoryFor(editor),
        repositoryFor(outsider),
      ]);

      const { data, error } = await adminClient
        .from('movies')
        .insert(
          {
            // Far above any real TMDb id, so this disposable row cannot collide
            // with cached metadata another test relies on.
            tmdb_id:
              900_000_000 + parseInt(randomUUID().replace(/-/g, '').slice(0, 6), 16),
            title: 'MOV-374 disposable movie',
            release_date: '2026-10-01',
            raw_json: {},
          },
        )
        .select('id')
        .single();

      if (error || !data) {
        throw new Error(`real-stack: could not create disposable movie: ${error?.message}`);
      }

      movieId = data.id;
    });

    afterAll(async () => {
      if (movieId) {
        await adminClient.from('movies').delete().eq('id', movieId);
      }

      await Promise.all(
        [owner, editor, outsider]
          .filter((account) => Boolean(account?.userId))
          .map((account) => adminClient.auth.admin.deleteUser(account.userId)),
      );
    });

    beforeEach(async () => {
      const watchlist = await createSharedWatchlist({
        name: `MOV-374 ${randomUUID().slice(0, 8)}`,
        repository: ownerRepository,
        userId: owner.userId,
      });

      watchlistId = watchlist.id;

      const { error: itemError } = await adminClient
        .from('watchlist_items')
        .insert({ movie_id: movieId, watchlist_id: watchlistId });

      if (itemError) {
        throw new Error(`real-stack: could not seed shared item: ${itemError.message}`);
      }

      const { inviteUrl } = await createSharedWatchlistInviteLink({
        actorUserId: owner.userId,
        baseUrl: 'https://moviecal.test',
        repository: ownerRepository,
        watchlistId,
      });

      inviteToken = decodeURIComponent(new URL(inviteUrl).pathname.split('/').pop() ?? '');

      const accepted = await acceptWatchlistInvite({
        actorUserId: editor.userId,
        repository: editorRepository,
        token: inviteToken,
      });

      expect(accepted.joined).toBe(true);
    });

    afterEach(async () => {
      if (watchlistId) {
        await adminClient.from('watchlists').delete().eq('id', watchlistId);
        watchlistId = '';
      }
    });

    it.each(['leave', 'remove'] as const)(
      '%s ends detail, mutation, targets, RLS reads, and calendar access on the next request', async (operation) => {
        const detailArgs = { actorUserId: editor.userId, repository: editorRepository, watchlistId };
        const feedArgs = { repository: feedRepository, userId: editor.userId };
        await expect(getWatchlistDetail(detailArgs)).resolves.toMatchObject({ watchlist: { canEdit: true } });
        expect((await listCalendarWatchlistItems(feedArgs)).map((item) => item.movie.id)).toContain(movieId);
        const editorMembershipId = await membershipIdFor(editor.userId);
        expect(editorMembershipId).not.toBeNull();

        if (operation === 'leave') {
          await leaveSharedWatchlist(detailArgs);
        } else {
          await removeSharedWatchlistMember({
            actorUserId: owner.userId, membershipId: editorMembershipId!,
            repository: ownerRepository, watchlistId,
          });
        }

        expect(await membershipIdFor(editor.userId)).toBeNull();
        await expect(getWatchlistDetail(detailArgs)).rejects.toMatchObject({ status: 403 });
        const getMovieDetails = async () => { throw new Error('Movie lookup must be unreachable.'); };
        await expect(addWatchlistItem({ ...detailArgs, getMovieDetails, tmdbId: 1 }))
          .rejects.toMatchObject({ status: 403 });
        const lists = await listUserWatchlists({ repository: editorRepository, userId: editor.userId });
        expect(lists.map((list) => list.id)).not.toContain(watchlistId);
        expect((await listCalendarWatchlistItems(feedArgs)).map((item) => item.movie.id)).not.toContain(movieId);
        await expect(getWatchlistDetail({
          actorUserId: owner.userId, repository: ownerRepository, watchlistId,
        })).resolves.toMatchObject({ watchlist: { canEdit: true } });

        const client = clients.get(editor.userId)!;
        const directRead = await client.from('watchlist_items').select('id').eq('watchlist_id', watchlistId);
        expect(directRead.error).toBeNull();
        expect(directRead.data).toEqual([]);
        const directWrite = await client.from('watchlist_items').insert({ movie_id: movieId, watchlist_id: watchlistId });
        expect(directWrite.error?.code).toBe('42501');

        const inviteArgs = { actorUserId: editor.userId, repository: editorRepository, token: inviteToken };
        await expect(acceptWatchlistInvite(inviteArgs)).resolves.toMatchObject({ joined: true });
        await expect(getWatchlistDetail(detailArgs)).resolves.toMatchObject({ watchlist: { canEdit: true } });
        expect((await listCalendarWatchlistItems(feedArgs)).map((item) => item.movie.id)).toContain(movieId);
        await leaveSharedWatchlist(detailArgs);
        // Rotation invalidates the previous invitation rather than restoring membership.
        await createSharedWatchlistInviteLink({
          actorUserId: owner.userId, baseUrl: 'https://moviecal.test', repository: ownerRepository, watchlistId,
        });
        await expect(acceptWatchlistInvite(inviteArgs))
          .rejects.toMatchObject({ message: 'Invite link is invalid or expired.', status: 404 });
        expect(await membershipIdFor(editor.userId)).toBeNull();
      },
    );

    it('protects the owner through domain operations, direct editor RLS, and service-role deletes', async () => {
      const ownerMembershipId = await membershipIdFor(owner.userId);
      expect(ownerMembershipId).not.toBeNull();
      const ownerArgs = { actorUserId: owner.userId, repository: ownerRepository, watchlistId };
      await expect(leaveSharedWatchlist(ownerArgs)).rejects.toMatchObject({ status: 403 });
      await expect(removeSharedWatchlistMember({ ...ownerArgs, membershipId: ownerMembershipId! }))
        .rejects.toMatchObject({ status: 403 });
      await expect(removeSharedWatchlistMember({ ...ownerArgs, membershipId: `owner:${owner.userId}` }))
        .rejects.toMatchObject({ message: 'Watchlist member not found.', status: 404 });
      await expect(removeSharedWatchlistMember({
        ...ownerArgs, actorUserId: editor.userId, repository: editorRepository, membershipId: ownerMembershipId!,
      })).rejects.toMatchObject({ message: 'Watchlist access denied.', status: 403 });
      const directEditorDelete = await clients.get(editor.userId)!
        .from('watchlist_memberships').delete().eq('id', ownerMembershipId!).select('id');
      expect(directEditorDelete.error).toBeNull();
      expect(directEditorDelete.data).toEqual([]);
      const { error } = await adminClient.from('watchlist_memberships').delete().eq('id', ownerMembershipId!);
      expect(error?.message).toContain('owner membership cannot be removed');
      expect(await membershipIdFor(owner.userId)).toBe(ownerMembershipId);
    });

    it('rejects a valid membership id from another list without deleting it', async () => {
      const other = await createSharedWatchlist({
        name: 'Other MOV-374 list', repository: ownerRepository, userId: owner.userId,
      });
      try {
        const otherInvite = await createSharedWatchlistInviteLink({
          actorUserId: owner.userId, baseUrl: 'https://moviecal.test', repository: ownerRepository, watchlistId: other.id,
        });
        await acceptWatchlistInvite({
          actorUserId: editor.userId, repository: editorRepository,
          token: decodeURIComponent(new URL(otherInvite.inviteUrl).pathname.split('/').pop()!),
        });
        const membership = await adminClient.from('watchlist_memberships').select('id')
          .eq('watchlist_id', other.id).eq('user_id', editor.userId).single();
        expect(membership.error).toBeNull();
        await expect(removeSharedWatchlistMember({
          actorUserId: owner.userId, repository: ownerRepository, watchlistId, membershipId: membership.data!.id,
        })).rejects.toMatchObject({ message: 'Watchlist member not found.', status: 404 });
        await expect(getWatchlistDetail({
          actorUserId: editor.userId, repository: editorRepository, watchlistId: other.id,
        })).resolves.toMatchObject({ watchlist: { id: other.id } });
      } finally {
        await adminClient.from('watchlists').delete().eq('id', other.id);
      }
    });

    it('discloses accepted member emails only to the owner; outsiders and pending invitees learn no metadata', async () => {
      const members = await listSharedWatchlistMemberProfiles({
        actorUserId: owner.userId, repository: ownerRepository, watchlistId,
      });
      expect(members.map((member) => member.email).sort()).toEqual([owner.email, editor.email].sort());
      await expect(listSharedWatchlistMemberProfiles({
        actorUserId: editor.userId, repository: editorRepository, watchlistId,
      })).rejects.toMatchObject({ message: 'Watchlist access denied.', status: 403 });

      async function assertDenied() {
        const args = { actorUserId: outsider.userId, repository: outsiderRepository, watchlistId };
        for (const operation of [getWatchlistDetail, leaveSharedWatchlist, listSharedWatchlistMemberProfiles]) {
          await expect(operation(args)).rejects.toMatchObject({ message: 'Watchlist access denied.', status: 403 });
        }
      }
      await assertDenied();
      const pending = await adminClient.from('watchlist_memberships').insert({
        watchlist_id: watchlistId, user_id: outsider.userId, role: 'editor',
        accepted_at: null, invited_by_user_id: owner.userId,
      });
      expect(pending.error).toBeNull();
      await assertDenied();
    });
  },
);
