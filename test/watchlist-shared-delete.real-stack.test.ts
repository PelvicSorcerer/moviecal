/**
 * MOV-335 — disposable real-stack probes for permanent owner-only shared-list
 * deletion. Migration 20260924000000 (MOV-330) already proves the DB-level
 * cascade for memberships when a service-role client deletes a watchlist row;
 * this file proves the rest of the MOV-335 acceptance criteria against a real
 * Supabase stack and the actual `deleteSharedWatchlist` app-layer function
 * (not just a raw DB delete):
 *
 * - an owner-authenticated client (real JWT, not service role) can delete a
 *   shared watchlist through the RLS policy added by MOV-330;
 * - the delete cascades watchlist_items and watchlist_invite_links, not just
 *   watchlist_memberships;
 * - a movie that only lived on the deleted shared list disappears from every
 *   member's calendar feed, while a movie also saved to an accessible list
 *   (the owner's personal watchlist here) survives;
 * - an editor or an outsider cannot delete the shared watchlist, and a
 *   personal watchlist can never be deleted through this path — both without
 *   mutating anything.
 *
 * Lane: real-stack (npm run lane:real-stack)
 */

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import {
  deleteSharedWatchlist,
  listCalendarWatchlistItems,
  WatchlistAccessError,
} from '../src/lib/watchlist';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const SHARED_ONLY_TMDB_ID = 27205; // Inception — saved only to the shared list.
const DUPLICATED_TMDB_ID = 603; // The Matrix — saved to the shared list and the owner's personal list.

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
  'permanent shared-watchlist deletion — real-stack (requires local Supabase)',
  () => {
    const adminClient = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const credentials: Record<string, { email: string; password: string }> = {};
    const userIds: Record<string, string> = {};
    const clients: Record<string, Client> = {};

    let personalId = '';
    let matrixMovieId = 0;
    let inceptionMovieId = 0;

    async function createUser(label: string): Promise<string> {
      const runId = randomUUID().replace(/-/g, '').slice(0, 12);
      const email = `rs-mov335-${label}-${runId}@moviecal.test`;
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

    function repositoryFor(label: string) {
      return createSupabaseWatchlistRepository({
        adminClient,
        userClient: clients[label],
      });
    }

    async function watchlistRow(id: string) {
      const { data } = await adminClient
        .from('watchlists')
        .select('id')
        .eq('id', id)
        .maybeSingle();

      return data;
    }

    async function seedMovie(tmdbId: number, title: string): Promise<number> {
      return seeded(
        await adminClient
          .from('movies')
          .upsert(
            {
              raw_json: {},
              release_date: '2026-01-01',
              title,
              tmdb_id: tmdbId,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'tmdb_id' },
          )
          .select('id')
          .single(),
        `movie ${title}`,
      ).id;
    }

    async function seedItem(watchlistId: string, movieId: number): Promise<void> {
      const { error } = await adminClient
        .from('watchlist_items')
        .insert({ movie_id: movieId, watchlist_id: watchlistId });

      if (error) {
        throw new Error(`real-stack: could not seed a watchlist item: ${error.message}`);
      }
    }

    /** Creates a fresh disposable shared watchlist owned by `owner`, with an
     * accepted editor membership, an active invite link, one shared-only
     * item, and one item duplicated onto the owner's personal watchlist. */
    async function seedDisposableSharedWatchlist(): Promise<string> {
      const sharedId = seeded(
        await adminClient
          .from('watchlists')
          .insert({
            kind: 'shared',
            name: 'MOV-335 disposable shared list',
            owner_user_id: userIds.owner,
          })
          .select('id')
          .single(),
        'disposable shared watchlist',
      ).id;

      const { error: membershipError } = await adminClient
        .from('watchlist_memberships')
        .insert({
          accepted_at: new Date().toISOString(),
          role: 'editor',
          user_id: userIds.editor,
          watchlist_id: sharedId,
        });

      if (membershipError) {
        throw new Error(`real-stack: could not seed the editor membership: ${membershipError.message}`);
      }

      const { error: inviteError } = await adminClient
        .from('watchlist_invite_links')
        .insert({
          created_by_user_id: userIds.owner,
          expires_at: null,
          token_hash: `mov-335-${randomUUID()}`,
          watchlist_id: sharedId,
        });

      if (inviteError) {
        throw new Error(`real-stack: could not seed the invite link: ${inviteError.message}`);
      }

      await seedItem(sharedId, inceptionMovieId);
      await seedItem(sharedId, matrixMovieId);

      return sharedId;
    }

    beforeAll(async () => {
      for (const label of ['owner', 'editor', 'outsider']) {
        await createUser(label);
        clients[label] = await signIn(label);
      }

      personalId = seeded(
        await adminClient.rpc('ensure_personal_watchlist_for_user', {
          target_user_id: userIds.owner,
        }),
        'personal watchlist',
      );

      matrixMovieId = await seedMovie(DUPLICATED_TMDB_ID, 'The Matrix');
      inceptionMovieId = await seedMovie(SHARED_ONLY_TMDB_ID, 'Inception');

      await seedItem(personalId, matrixMovieId);
    });

    afterAll(async () => {
      await Promise.all(
        Object.values(userIds).map((id) => adminClient.auth.admin.deleteUser(id)),
      );
    });

    describe('non-owner and personal-list deletion attempts', () => {
      it.each(['editor', 'outsider'] as const)(
        'refuses a %s deletion attempt and mutates nothing',
        async (label) => {
          const sharedId = await seedDisposableSharedWatchlist();

          await expect(
            deleteSharedWatchlist({
              actorUserId: userIds[label],
              repository: repositoryFor(label),
              watchlistId: sharedId,
            }),
          ).rejects.toBeInstanceOf(WatchlistAccessError);

          expect(await watchlistRow(sharedId)).not.toBeNull();

          const { data: items } = await adminClient
            .from('watchlist_items')
            .select('id')
            .eq('watchlist_id', sharedId);
          const { data: memberships } = await adminClient
            .from('watchlist_memberships')
            .select('id')
            .eq('watchlist_id', sharedId);

          expect(items).toHaveLength(2);
          expect(memberships).toHaveLength(2);

          await adminClient.from('watchlists').delete().eq('id', sharedId);
        },
      );

      it('never deletes a personal watchlist through the shared-delete path', async () => {
        await expect(
          deleteSharedWatchlist({
            actorUserId: userIds.owner,
            repository: repositoryFor('owner'),
            watchlistId: personalId,
          }),
        ).rejects.toBeInstanceOf(WatchlistAccessError);

        expect(await watchlistRow(personalId)).not.toBeNull();

        const { data: items } = await adminClient
          .from('watchlist_items')
          .select('id')
          .eq('watchlist_id', personalId);

        expect(items).toHaveLength(1);
      });
    });

    describe('owner-confirmed permanent deletion', () => {
      it('deletes the shared watchlist through RLS and cascades items, memberships, and invite links', async () => {
        const sharedId = await seedDisposableSharedWatchlist();

        await expect(
          deleteSharedWatchlist({
            actorUserId: userIds.owner,
            repository: repositoryFor('owner'),
            watchlistId: sharedId,
          }),
        ).resolves.toBeUndefined();

        expect(await watchlistRow(sharedId)).toBeNull();

        const [items, memberships, inviteLinks] = await Promise.all([
          adminClient.from('watchlist_items').select('id').eq('watchlist_id', sharedId),
          adminClient.from('watchlist_memberships').select('id').eq('watchlist_id', sharedId),
          adminClient.from('watchlist_invite_links').select('id').eq('watchlist_id', sharedId),
        ]);

        expect(items.data).toEqual([]);
        expect(memberships.data).toEqual([]);
        expect(inviteLinks.data).toEqual([]);
      });

      it('removes list-only movies from every member calendar feed while a duplicated movie survives', async () => {
        const sharedId = await seedDisposableSharedWatchlist();

        const ownerFeedBefore = await listCalendarWatchlistItems({
          repository: repositoryFor('owner'),
          userId: userIds.owner,
        });

        expect(ownerFeedBefore.map((item) => item.movie.tmdbId).sort()).toEqual(
          [SHARED_ONLY_TMDB_ID, DUPLICATED_TMDB_ID].sort(),
        );

        const editorFeedBefore = await listCalendarWatchlistItems({
          repository: repositoryFor('editor'),
          userId: userIds.editor,
        });

        expect(editorFeedBefore.map((item) => item.movie.tmdbId).sort()).toEqual(
          [SHARED_ONLY_TMDB_ID, DUPLICATED_TMDB_ID].sort(),
        );

        await deleteSharedWatchlist({
          actorUserId: userIds.owner,
          repository: repositoryFor('owner'),
          watchlistId: sharedId,
        });

        const ownerFeedAfter = await listCalendarWatchlistItems({
          repository: repositoryFor('owner'),
          userId: userIds.owner,
        });

        // The Matrix survives because it is still saved to the owner's personal
        // watchlist; Inception only ever lived on the now-deleted shared list.
        expect(ownerFeedAfter.map((item) => item.movie.tmdbId)).toEqual([DUPLICATED_TMDB_ID]);

        const editorFeedAfter = await listCalendarWatchlistItems({
          repository: repositoryFor('editor'),
          userId: userIds.editor,
        });

        // The former editor has no personal-list copy of either movie, so
        // losing membership empties their feed on the very next request.
        expect(editorFeedAfter).toEqual([]);
      });
    });
  },
);
