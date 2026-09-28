/**
 * MOV-407: exercise INSERT ... RETURNING under real RLS, through the same
 * domain/repository and cookie API used by the web app. No auth or DB mocks.
 * Run only against local Supabase or a disposable/dev project.
 */
import { randomUUID } from 'node:crypto';

import { createClient, type Session } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST } from '../src/app/api/watchlist/shared/route';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../src/lib/auth/cookies';
import type { Database } from '../src/lib/supabase/database';
import type { ServerSupabaseClient } from '../src/lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import {
  createSharedWatchlist,
  hashWatchlistInviteToken,
  renameSharedWatchlist,
  type WatchlistRepository,
} from '../src/lib/watchlist';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// This test creates/deletes auth users. Refuse unapproved targets before even
// constructing a client. The hosted dev ref is documented in deployment-plan.md.
const disposableTargets = new Set([
  'http://127.0.0.1:54321',
  'http://localhost:54321',
  'http://[::1]:54321',
  'https://utaxvnghaqungrvrqnbc.supabase.co',
]);
if (!disposableTargets.has((SUPABASE_URL ?? '').replace(/\/$/, ''))) {
  throw new Error('MOV-407 real-stack tests require local Supabase or moviecal-ci-dev.');
}

const LABELS = ['owner', 'member', 'outsider'] as const;
type Label = (typeof LABELS)[number];
type Actor = {
  client: ServerSupabaseClient;
  repository: WatchlistRepository;
  session: Session;
  userId: string;
};

function returned<T>(response: { data: T | null; error: unknown }): T {
  expect(response.error).toBeNull();
  expect(response.data).not.toBeNull();
  return response.data!;
}

describe('shared watchlist creation — real RLS (MOV-407)', () => {
  const options = { auth: { autoRefreshToken: false, persistSession: false } };
  const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, options);
  const actors = {} as Record<Label, Actor>;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    // Deliberately fail on missing/unreachable infrastructure instead of
    // silently skipping the regression that mocked lanes cannot prove.
    for (const label of LABELS) {
      const runId = randomUUID();
      const credentials = {
        email: `rs-mov407-${label}-${runId}@moviecal.test`,
        password: `Moviecal-${runId}-Aa1!`,
      };
      const created = await admin.auth.admin.createUser({
        ...credentials,
        email_confirm: true,
      });
      expect(created.error).toBeNull();
      const userId = created.data.user!.id;
      createdUserIds.push(userId);
      const client = createClient<Database>(SUPABASE_URL, ANON_KEY, options);
      const signedIn = await client.auth.signInWithPassword(credentials);
      expect(signedIn.error).toBeNull();
      expect(signedIn.data.session).not.toBeNull();
      actors[label] = {
        client,
        repository: createSupabaseWatchlistRepository({ adminClient: admin, userClient: client }),
        session: signedIn.data.session!,
        userId,
      };
    }
  }, 60_000);

  afterAll(async () => {
    // Revoke these disposable sessions, then cascade only this run's rows.
    for (const actor of Object.values(actors)) {
      expect((await actor.client.auth.signOut()).error).toBeNull();
    }
    for (const id of createdUserIds) {
      expect((await admin.auth.admin.deleteUser(id)).error).toBeNull();
    }
  }, 60_000);

  function create(label: Label = 'owner') {
    return createSharedWatchlist({
      name: '  Friday   movie night  ',
      repository: actors[label].repository,
      userId: actors[label].userId,
    });
  }

  it.each(['owner', 'outsider'] as const)(
    'returns and persists a new shared watchlist for the %s account',
    async (label) => {
      const watchlist = await create(label);
      expect(watchlist).toEqual({
        canEdit: true,
        id: expect.any(String),
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: actors[label].userId,
      });
      const stored = returned(await actors[label].client.from('watchlists')
        .select('id, owner_user_id, kind, name').eq('id', watchlist.id).single());
      expect(stored).toEqual({
        id: watchlist.id,
        owner_user_id: actors[label].userId,
        kind: 'shared',
        name: watchlist.name,
      });
      const ownerMembership = returned(await actors[label].client.from('watchlist_memberships')
        .select('role, accepted_at').eq('watchlist_id', watchlist.id)
        .eq('user_id', actors[label].userId).single());
      expect(ownerMembership.role).toBe('owner');
      expect(ownerMembership.accepted_at).not.toBeNull();
      const otherLabel = label === 'owner' ? 'outsider' : 'owner';
      expect(returned(await actors[otherLabel].client.from('watchlists')
        .select('id').eq('id', watchlist.id))).toEqual([]);
    },
    20_000,
  );

  it('returns 201 from the real cookie API, survives a fresh client read, and can be renamed', async () => {
    const actor = actors.owner;
    const request = new NextRequest('https://moviecal.test/api/watchlist/shared', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Weekend   movies  ' }),
    });
    request.cookies.set(ACCESS_TOKEN_COOKIE, actor.session.access_token);
    request.cookies.set(REFRESH_TOKEN_COOKIE, actor.session.refresh_token);
    const response = await POST(request);
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.watchlist).toMatchObject({
      id: expect.any(String), kind: 'shared', name: 'Weekend movies', ownerUserId: actor.userId,
    });

    const freshClient = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      ...options,
      global: { headers: { Authorization: `Bearer ${actor.session.access_token}` } },
    });
    expect(returned(await freshClient.from('watchlists').select('name')
      .eq('id', body.watchlist.id).single()).name).toBe('Weekend movies');
    await expect(renameSharedWatchlist({
      actorUserId: actor.userId,
      repository: actor.repository,
      watchlistId: body.watchlist.id,
      name: 'Renamed weekend movies',
    })).resolves.toMatchObject({ id: body.watchlist.id, name: 'Renamed weekend movies' });
  }, 20_000);

  it('still refuses an INSERT RETURNING that forges another user as owner', async () => {
    const result = await actors.outsider.client.from('watchlists').insert({
      kind: 'shared', name: 'Forbidden', owner_user_id: actors.owner.userId,
    }).select('id').single();
    expect(result.error?.code).toBe('42501');
    expect(result.data).toBeNull();
  });

  it('returns membership inserts/updates and preserves pending versus accepted read access', async () => {
    const watchlist = await create();
    const membership = returned(await actors.owner.client.from('watchlist_memberships').insert({
      watchlist_id: watchlist.id, user_id: actors.member.userId, role: 'editor', accepted_at: null,
    }).select('id, accepted_at').single());
    expect(membership.accepted_at).toBeNull();
    expect(returned(await actors.member.client.from('watchlists').select('id')
      .eq('id', watchlist.id))).toEqual([]);
    expect(returned(await actors.member.client.from('watchlist_memberships').select('id')
      .eq('id', membership.id).single()).id).toBe(membership.id);

    const accepted = returned(await actors.owner.client.from('watchlist_memberships')
      .update({ accepted_at: new Date().toISOString() }).eq('id', membership.id)
      .select('id, accepted_at').single());
    expect(accepted.accepted_at).not.toBeNull();
    expect(returned(await actors.member.client.from('watchlists').select('id')
      .eq('id', watchlist.id).single()).id).toBe(watchlist.id);
    expect(returned(await actors.outsider.client.from('watchlist_memberships').select('id')
      .eq('watchlist_id', watchlist.id))).toEqual([]);
  }, 20_000);

  it('returns invite-link inserts/updates for the owner without exposing links to outsiders', async () => {
    const watchlist = await create();
    const invite = returned(await actors.owner.client.from('watchlist_invite_links').insert({
      watchlist_id: watchlist.id,
      created_by_user_id: actors.owner.userId,
      token_hash: hashWatchlistInviteToken(randomUUID()),
    }).select('id, revoked_at').single());
    expect(invite.revoked_at).toBeNull();
    const revoked = returned(await actors.owner.client.from('watchlist_invite_links')
      .update({ revoked_at: new Date().toISOString() }).eq('id', invite.id)
      .select('id, revoked_at').single());
    expect(revoked.revoked_at).not.toBeNull();
    expect(returned(await actors.outsider.client.from('watchlist_invite_links').select('id')
      .eq('watchlist_id', watchlist.id))).toEqual([]);
  }, 20_000);
});
