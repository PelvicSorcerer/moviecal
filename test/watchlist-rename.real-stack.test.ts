/**
 * MOV-372 — disposable real-stack checks for the shared-list rename operation.
 *
 * Drives renameSharedWatchlist through the real Supabase repository as each
 * actor (`owner`, accepted `editor`, `pending` invitee, `outsider`) so the
 * domain decision and the RLS/trigger boundary from MOV-330 are exercised
 * together. Everything created here is disposable and removed in afterAll by
 * deleting the auth users.
 *
 * Lane: real-stack (npm run lane:real-stack)
 */

import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/lib/supabase/database';
import type { ServerSupabaseClient } from '../src/lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import {
  hashWatchlistInviteToken,
  listUserWatchlists,
  renameSharedWatchlist,
  resolveWatchlistInvite,
  WatchlistAccessError,
  WatchlistInputError,
  type WatchlistRepository,
} from '../src/lib/watchlist';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const BASELINE_NAME = 'MOV-372 rename probe';
const LABELS = ['owner', 'editor', 'pending', 'outsider'] as const;

type Label = (typeof LABELS)[number];

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
  'shared watchlist rename — real-stack (requires local Supabase)',
  () => {
    const adminClient = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const userIds = {} as Record<Label, string>;
    const repositories = {} as Record<Label, WatchlistRepository>;
    const inviteToken = randomUUID();

    let sharedId = '';
    let personalId = '';

    async function createActor(label: Label): Promise<void> {
      const runId = randomUUID().replace(/-/g, '').slice(0, 12);
      const credentials = {
        email: `rs-mov372-${label}-${runId}@moviecal.test`,
        password: `Moviecal-${runId}-Aa1!`,
      };
      const { data, error } = await adminClient.auth.admin.createUser({
        ...credentials,
        email_confirm: true,
      });

      if (error || !data.user) {
        throw new Error(`real-stack: could not create ${label}: ${error?.message}`);
      }

      userIds[label] = data.user.id;

      const anonClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const signIn = await anonClient.auth.signInWithPassword(credentials);

      if (signIn.error || !signIn.data.session?.access_token) {
        throw new Error(`real-stack: sign-in failed for ${label}: ${signIn.error?.message}`);
      }

      const userClient: ServerSupabaseClient = createClient<Database>(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        {
          auth: { autoRefreshToken: false, persistSession: false },
          global: {
            headers: { Authorization: `Bearer ${signIn.data.session.access_token}` },
          },
        },
      );

      repositories[label] = createSupabaseWatchlistRepository({ adminClient, userClient });
    }

    async function storedName(id: string): Promise<string | undefined> {
      const { data } = await adminClient
        .from('watchlists')
        .select('name')
        .eq('id', id)
        .maybeSingle();

      return data?.name;
    }

    function rename(label: Label, name: string, watchlistId = sharedId) {
      return renameSharedWatchlist({
        actorUserId: userIds[label],
        name,
        repository: repositories[label],
        watchlistId,
      });
    }

    beforeAll(async () => {
      for (const label of LABELS) {
        await createActor(label);
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

      seeded(
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
          .select('id'),
        'memberships',
      );
      seeded(
        await adminClient
          .from('watchlist_invite_links')
          .insert({
            created_by_user_id: userIds.owner,
            token_hash: hashWatchlistInviteToken(inviteToken),
            watchlist_id: sharedId,
          })
          .select('id'),
        'invite link',
      );
    });

    afterAll(async () => {
      await Promise.all(
        Object.values(userIds).map((id) => adminClient.auth.admin.deleteUser(id)),
      );
    });

    it.each(['owner', 'editor'] as const)(
      'lets the %s rename and returns the committed name',
      async (label) => {
        const name = `Renamed by ${label}`;
        const result = await rename(label, `  ${name}  `);

        expect(result).toMatchObject({ id: sharedId, kind: 'shared', name });
        expect(await storedName(sharedId)).toBe(name);
      },
    );

    it.each(['pending', 'outsider'] as const)(
      'refuses the %s without changing the name',
      async (label) => {
        const before = await storedName(sharedId);

        await expect(rename(label, 'Should not stick')).rejects.toBeInstanceOf(
          WatchlistAccessError,
        );
        expect(await storedName(sharedId)).toBe(before);
      },
    );

    it('refuses the database write itself when the domain check is bypassed', async () => {
      const before = await storedName(sharedId);

      // Trusted-boundary check: even a caller that skips the domain rule cannot
      // rename as a non-editor, because the repository writes as the actor.
      await expect(
        repositories.pending.renameWatchlist({ name: 'Bypass', watchlistId: sharedId }),
      ).resolves.toBeNull();
      await expect(
        repositories.outsider.renameWatchlist({ name: 'Bypass', watchlistId: sharedId }),
      ).resolves.toBeNull();
      expect(await storedName(sharedId)).toBe(before);
    });

    it('rejects blank and overlong names without changing the name', async () => {
      const before = await storedName(sharedId);

      await expect(rename('editor', '   ')).rejects.toBeInstanceOf(WatchlistInputError);
      await expect(rename('owner', 'n'.repeat(81))).rejects.toBeInstanceOf(
        WatchlistInputError,
      );
      expect(await storedName(sharedId)).toBe(before);
    });

    it('leaves a personal list untouched, even for its owner', async () => {
      const before = await storedName(personalId);

      await expect(rename('owner', 'Renamed personal', personalId)).rejects.toBeInstanceOf(
        WatchlistAccessError,
      );
      await expect(
        repositories.owner.renameWatchlist({ name: 'Bypass', watchlistId: personalId }),
      ).resolves.toBeNull();
      expect(await storedName(personalId)).toBe(before);
      expect(before).toBe('My watchlist');
    });

    it('resolves concurrent renames to one committed name that reads and invite preview use', async () => {
      const results = await Promise.all([
        rename('owner', 'Concurrent A'),
        rename('editor', 'Concurrent B'),
        rename('owner', 'Concurrent C'),
        rename('editor', 'Concurrent D'),
      ]);
      const committed = await storedName(sharedId);

      expect(results.map((result) => result.name).sort()).toEqual([
        'Concurrent A',
        'Concurrent B',
        'Concurrent C',
        'Concurrent D',
      ]);
      expect(results.map((result) => result.name)).toContain(committed);

      const ownerLists = await listUserWatchlists({
        repository: repositories.owner,
        userId: userIds.owner,
      });
      const editorLists = await listUserWatchlists({
        repository: repositories.editor,
        userId: userIds.editor,
      });
      const invite = await resolveWatchlistInvite({
        repository: repositories.outsider,
        token: inviteToken,
      });

      expect(ownerLists.find((list) => list.id === sharedId)?.name).toBe(committed);
      expect(editorLists.find((list) => list.id === sharedId)?.name).toBe(committed);
      expect(invite?.watchlist.name).toBe(committed);
    });
  },
);
