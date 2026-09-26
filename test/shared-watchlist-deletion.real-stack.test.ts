/**
 * MOV-373 — disposable real-stack probes for owner-only permanent shared-list
 * deletion, its cascade, and the calendar access loss that follows.
 *
 * Everything runs through the real shared-domain operation
 * (`deleteSharedWatchlist`) over the real Supabase repository, as a real
 * Supabase role: `owner`, `editor` (accepted membership), and `outsider` (no
 * relationship). That is deliberate — the point of this lane is that the
 * authorization refusals, the ON DELETE CASCADE atomicity, the invite-hash
 * invalidation, and the feed recomputation all hold against actual Postgres
 * RLS, triggers, and foreign keys rather than a modelled store.
 *
 * Every resource created here is disposable: the auth users are deleted in
 * afterAll (which cascades their watchlists, including the personal lists that
 * nothing else may delete) and the two seeded movie rows are removed
 * explicitly.
 *
 * Lane: real-stack (npm run lane:real-stack)
 */

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import {
  acceptWatchlistInvite,
  createSharedWatchlistInviteLink,
  deleteSharedWatchlist,
  listCalendarWatchlistItems,
  listUserWatchlists,
  listWatchlistItems,
  resolveWatchlistInvite,
  WatchlistAccessError,
  WatchlistNotFoundError,
  type WatchlistRepository,
} from '../src/lib/watchlist';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const BASE_URL = 'https://moviecal.test';
const ROLES = ['owner', 'editor', 'outsider'] as const;

type Role = (typeof ROLES)[number];
type Client = SupabaseClient<Database>;

/** Unwraps a seeding response, failing the run loudly rather than mid-probe. */
function seeded<T>(
  response: { data: T | null; error: { message: string } | null },
  what: string,
): NonNullable<T> {
  if (response.error || response.data === null || response.data === undefined) {
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
  'shared-watchlist deletion — real-stack (requires local Supabase)',
  () => {
    const adminClient = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const credentials: Record<string, { email: string; password: string }> = {};
    const userIds: Record<string, string> = {};
    const repositories: Record<string, WatchlistRepository> = {};

    // Two disposable movie rows, one shared across both shared lists and one
    // exclusive to the list that gets deleted.
    const sharedTmdbId =
      900_000_000 + parseInt(randomUUID().replace(/-/g, '').slice(0, 6), 16) * 2;
    const exclusiveTmdbId = sharedTmdbId + 1;
    let sharedMovieId = 0;
    let exclusiveMovieId = 0;

    let deletedListId = '';
    let retainedListId = '';
    let ownerPersonalId = '';
    let inviteToken = '';

    async function createRole(label: Role): Promise<void> {
      const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
      const email = `rs-mov373-${label}-${suffix}@moviecal.test`;
      const password = `Moviecal-${suffix}-Aa1!`;
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

      const anonClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const session = await anonClient.auth.signInWithPassword(credentials[label]);

      if (session.error || !session.data.session?.access_token) {
        throw new Error(
          `real-stack: sign-in failed for ${label}: ${session.error?.message}`,
        );
      }

      const userClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: {
          headers: { Authorization: `Bearer ${session.data.session.access_token}` },
        },
      });

      repositories[label] = createSupabaseWatchlistRepository({
        adminClient,
        userClient,
      });
    }

    async function seedMovie(tmdbId: number, title: string): Promise<number> {
      const { data, error } = await adminClient
        .from('movies')
        .insert({
          raw_json: { id: tmdbId, title },
          release_date: '2027-05-14',
          title,
          tmdb_id: tmdbId,
        })
        .select('id')
        .single();

      if (error || !data) {
        throw new Error(`real-stack: could not seed movie ${tmdbId}: ${error?.message}`);
      }

      return data.id;
    }

    async function seedSharedList(name: string): Promise<string> {
      const { data, error } = await adminClient
        .from('watchlists')
        .insert({ kind: 'shared', name, owner_user_id: userIds.owner })
        .select('id')
        .single();

      if (error || !data) {
        throw new Error(
          `real-stack: could not seed the shared watchlist ${name}: ${error?.message}`,
        );
      }

      return data.id;
    }

    async function addItem(watchlistId: string, movieId: number): Promise<void> {
      const { error } = await adminClient
        .from('watchlist_items')
        .insert({ movie_id: movieId, watchlist_id: watchlistId });

      if (error) {
        throw new Error(`real-stack: could not seed a watchlist item: ${error.message}`);
      }
    }

    async function countRows(
      table: 'watchlist_items' | 'watchlist_memberships' | 'watchlist_invite_links',
      watchlistId: string,
    ): Promise<number> {
      const { count, error } = await adminClient
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('watchlist_id', watchlistId);

      if (error) {
        throw new Error(`real-stack: could not count ${table}: ${error.message}`);
      }

      return count ?? 0;
    }

    async function watchlistRow(id: string) {
      const { data } = await adminClient
        .from('watchlists')
        .select('id, kind, name, owner_user_id')
        .eq('id', id)
        .maybeSingle();

      return data;
    }

    beforeAll(async () => {
      for (const label of ROLES) {
        await createRole(label);
      }

      sharedMovieId = await seedMovie(sharedTmdbId, 'MOV-373 shared probe');
      exclusiveMovieId = await seedMovie(exclusiveTmdbId, 'MOV-373 exclusive probe');

      ownerPersonalId = seeded(
        await adminClient.rpc('ensure_personal_watchlist_for_user', {
          target_user_id: userIds.owner,
        }),
        'owner personal watchlist',
      );
      seeded(
        await adminClient.rpc('ensure_personal_watchlist_for_user', {
          target_user_id: userIds.editor,
        }),
        'editor personal watchlist',
      );

      deletedListId = await seedSharedList('MOV-373 list under test');
      retainedListId = await seedSharedList('MOV-373 retained list');

      const acceptedAt = new Date().toISOString();
      const { error: membershipError } = await adminClient
        .from('watchlist_memberships')
        .insert(
          [deletedListId, retainedListId].map((watchlistId) => ({
            accepted_at: acceptedAt,
            invited_by_user_id: userIds.owner,
            role: 'editor',
            user_id: userIds.editor,
            watchlist_id: watchlistId,
          })),
        );

      if (membershipError) {
        throw new Error(
          `real-stack: could not seed memberships: ${membershipError.message}`,
        );
      }

      await addItem(deletedListId, sharedMovieId);
      await addItem(deletedListId, exclusiveMovieId);
      await addItem(retainedListId, sharedMovieId);
      await addItem(ownerPersonalId, sharedMovieId);

      // A live invite link on the list under test, created through the same
      // domain operation a real owner would use.
      const invite = await createSharedWatchlistInviteLink({
        actorUserId: userIds.owner,
        baseUrl: BASE_URL,
        repository: repositories.owner,
        watchlistId: deletedListId,
      });

      inviteToken = decodeURIComponent(
        new URL(invite.inviteUrl).pathname.split('/').pop() ?? '',
      );
    });

    afterAll(async () => {
      await Promise.all(
        Object.values(userIds).map((id) => adminClient.auth.admin.deleteUser(id)),
      );
      await adminClient
        .from('movies')
        .delete()
        .in('tmdb_id', [sharedTmdbId, exclusiveTmdbId]);
    });

    describe('only the owner may delete, and a refusal changes nothing', () => {
      it.each(['editor', 'outsider'] as const)(
        'refuses %s and leaves the list, items, memberships, and invite in place',
        async (label) => {
          await expect(
            deleteSharedWatchlist({
              actorUserId: userIds[label],
              repository: repositories[label],
              watchlistId: deletedListId,
            }),
          ).rejects.toBeInstanceOf(WatchlistAccessError);

          expect(await watchlistRow(deletedListId)).not.toBeNull();
          expect(await countRows('watchlist_items', deletedListId)).toBe(2);
          expect(await countRows('watchlist_memberships', deletedListId)).toBe(2);
          expect(await countRows('watchlist_invite_links', deletedListId)).toBe(1);
        },
      );

      it('refuses an outsider without disclosing any private list data', async () => {
        const error = await deleteSharedWatchlist({
          actorUserId: userIds.outsider,
          repository: repositories.outsider,
          watchlistId: deletedListId,
        }).catch((raised: unknown) => raised);

        expect(error).toBeInstanceOf(WatchlistAccessError);
        expect((error as Error).message).toBe('Watchlist access denied.');
        expect((error as Error).message).not.toContain('MOV-373');
        expect((error as Error).message).not.toContain(userIds.owner);
      });

      it("refuses a delete aimed at the owner's personal list and keeps its movies", async () => {
        await expect(
          deleteSharedWatchlist({
            actorUserId: userIds.owner,
            repository: repositories.owner,
            watchlistId: ownerPersonalId,
          }),
        ).rejects.toBeInstanceOf(WatchlistAccessError);

        expect(await watchlistRow(ownerPersonalId)).not.toBeNull();
        expect(await countRows('watchlist_items', ownerPersonalId)).toBe(1);
      });

      it('refuses an unknown watchlist id as not found', async () => {
        await expect(
          deleteSharedWatchlist({
            actorUserId: userIds.owner,
            repository: repositories.owner,
            watchlistId: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(WatchlistNotFoundError);
      });
    });

    describe('the owner delete cascades atomically', () => {
      it('serves the editor both movies while they still have access', async () => {
        const items = await listCalendarWatchlistItems({
          repository: repositories.editor,
          userId: userIds.editor,
        });

        expect(items.map((item) => item.movie.tmdbId).sort()).toEqual(
          [sharedTmdbId, exclusiveTmdbId].sort(),
        );
      });

      it('removes the list with its items, memberships, and invite hashes', async () => {
        const result = await deleteSharedWatchlist({
          actorUserId: userIds.owner,
          repository: repositories.owner,
          watchlistId: deletedListId,
        });

        expect(result).toMatchObject({ deleted: true });
        expect(result.watchlist.id).toBe(deletedListId);

        expect(await watchlistRow(deletedListId)).toBeNull();
        expect(await countRows('watchlist_items', deletedListId)).toBe(0);
        expect(await countRows('watchlist_memberships', deletedListId)).toBe(0);
        expect(await countRows('watchlist_invite_links', deletedListId)).toBe(0);
      });

      it('leaves the retained shared list and the personal list whole', async () => {
        expect(await watchlistRow(retainedListId)).not.toBeNull();
        expect(await countRows('watchlist_items', retainedListId)).toBe(1);
        expect(await countRows('watchlist_memberships', retainedListId)).toBe(2);
        expect(await watchlistRow(ownerPersonalId)).not.toBeNull();
        expect(await countRows('watchlist_items', ownerPersonalId)).toBe(1);
      });

      it('reports a repeated deletion as not found', async () => {
        await expect(
          deleteSharedWatchlist({
            actorUserId: userIds.owner,
            repository: repositories.owner,
            watchlistId: deletedListId,
          }),
        ).rejects.toMatchObject({
          message: 'Watchlist not found.',
          name: WatchlistNotFoundError.name,
        });
      });

      it('invalidates the outstanding invite for the deleted list', async () => {
        await expect(
          resolveWatchlistInvite({
            repository: repositories.outsider,
            token: inviteToken,
          }),
        ).resolves.toBeNull();

        await expect(
          acceptWatchlistInvite({
            actorUserId: userIds.outsider,
            repository: repositories.outsider,
            token: inviteToken,
          }),
        ).rejects.toBeInstanceOf(WatchlistNotFoundError);

        const { data: outsiderMemberships } = await adminClient
          .from('watchlist_memberships')
          .select('id')
          .eq('user_id', userIds.outsider);

        expect(outsiderMemberships).toEqual([]);
      });
    });

    describe('the former member loses access at the next request', () => {
      it('drops the deleted list from the editor\'s accessible set', async () => {
        const accessible = await listUserWatchlists({
          repository: repositories.editor,
          userId: userIds.editor,
        });

        expect(accessible.map((watchlist) => watchlist.id)).toContain(retainedListId);
        expect(accessible.map((watchlist) => watchlist.id)).not.toContain(deletedListId);
      });

      it('refuses the editor\'s item read for the deleted list', async () => {
        await expect(
          listWatchlistItems({
            actorUserId: userIds.editor,
            repository: repositories.editor,
            watchlistId: deletedListId,
          }),
        ).rejects.toBeInstanceOf(WatchlistNotFoundError);
      });

      it('drops the deleted-list-only movie from the editor\'s private feed but keeps the duplicate', async () => {
        const items = await listCalendarWatchlistItems({
          repository: repositories.editor,
          userId: userIds.editor,
        });
        const tmdbIds = items.map((item) => item.movie.tmdbId);

        expect(tmdbIds).not.toContain(exclusiveTmdbId);
        // Still sourced from the retained shared list the editor can access.
        expect(tmdbIds).toContain(sharedTmdbId);
      });

      it("keeps the owner's own private feed intact", async () => {
        const items = await listCalendarWatchlistItems({
          repository: repositories.owner,
          userId: userIds.owner,
        });
        const tmdbIds = items.map((item) => item.movie.tmdbId);

        expect(tmdbIds).toContain(sharedTmdbId);
        expect(tmdbIds).not.toContain(exclusiveTmdbId);
      });
    });

    describe('the database refuses a delete the domain layer never issues', () => {
      it('filters an authenticated delete of a shared list the caller does not own', async () => {
        // The editor's own JWT against the row directly: RLS's
        // "owners can delete shared watchlists" policy filters it silently.
        const editorClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const session = await editorClient.auth.signInWithPassword(credentials.editor);
        const scoped = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
          global: {
            headers: {
              Authorization: `Bearer ${session.data.session?.access_token ?? ''}`,
            },
          },
        });

        const { data, error } = await scoped
          .from('watchlists')
          .delete()
          .eq('id', retainedListId)
          .select('id');

        expect(error).toBeNull();
        expect(data).toEqual([]);
        expect(await watchlistRow(retainedListId)).not.toBeNull();
      });
    });
  },
);
