/** MOV-331: transaction, RLS, and uniqueness checks on a disposable database. */
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../src/lib/supabase/database';
import { createSupabaseWatchlistRepository } from '../src/lib/supabase/watchlist';
import {
  createSharedWatchlist,
  createSharedWatchlistInviteLink,
  hashWatchlistInviteToken,
  revokeSharedWatchlistInviteLink,
} from '../src/lib/watchlist';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!new Set([
  'http://127.0.0.1:54321', 'http://localhost:54321',
  'http://[::1]:54321', 'https://utaxvnghaqungrvrqnbc.supabase.co',
]).has((url ?? '').replace(/\/$/, ''))) {
  throw new Error('MOV-331 real-stack tests require local Supabase or moviecal-ci-dev.');
}

const options = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient<Database>(url, serviceKey, options);
type Client = ReturnType<typeof createClient<Database>>;
const users: { id: string; client: Client }[] = [];

async function makeUser() {
  const runId = randomUUID();
  const credentials = {
    email: `rs-mov331-${runId}@moviecal.test`,
    password: `Moviecal-${runId}-Aa1!`,
  };
  const created = await admin.auth.admin.createUser({ ...credentials, email_confirm: true });
  expect(created.error).toBeNull();
  const client = createClient<Database>(url, anonKey, options);
  expect((await client.auth.signInWithPassword(credentials)).error).toBeNull();
  const user = { id: created.data.user!.id, client };
  users.push(user);
  return user;
}

describe('atomic seven-day invites — real database', () => {
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let outsider: Awaited<ReturnType<typeof makeUser>>;
  let listId: string;
  let secondListId: string;

  beforeAll(async () => {
    owner = await makeUser();
    outsider = await makeUser();
    const repository = createSupabaseWatchlistRepository({
      adminClient: admin, userClient: owner.client,
    });
    listId = (await createSharedWatchlist({
      name: 'First', repository, userId: owner.id,
    })).id;
    secondListId = (await createSharedWatchlist({
      name: 'Second', repository, userId: owner.id,
    })).id;
  }, 60_000);

  afterAll(async () => {
    for (const user of users) {
      expect((await user.client.auth.signOut()).error).toBeNull();
      expect((await admin.auth.admin.deleteUser(user.id)).error).toBeNull();
    }
  }, 60_000);

  async function links(id = listId) {
    const result = await admin.from('watchlist_invite_links')
      .select('token_hash, created_at, expires_at, revoked_at')
      .eq('watchlist_id', id).order('created_at');
    expect(result.error).toBeNull();
    return result.data!;
  }

  it('limits owner creation, serializes rotations, rolls back failure, and revokes', async () => {
    const repository = createSupabaseWatchlistRepository({
      adminClient: admin, userClient: owner.client,
    });
    const create = () => createSharedWatchlistInviteLink({
      actorUserId: owner.id, baseUrl: 'https://moviecal.test',
      repository, watchlistId: listId,
    });
    const first = await create();
    const firstToken = new URL(first.inviteUrl).pathname.split('/').pop()!;
    const firstHash = hashWatchlistInviteToken(firstToken);
    const initial = (await links()).find((link) => link.token_hash === firstHash)!;
    expect(initial.revoked_at).toBeNull();
    expect(Date.parse(initial.expires_at!) - Date.parse(initial.created_at))
      .toBe(7 * 24 * 60 * 60 * 1000);
    expect(JSON.stringify(await links())).not.toContain(firstToken);

    const outsiderRepository = createSupabaseWatchlistRepository({
      adminClient: admin, userClient: outsider.client,
    });
    await expect(createSharedWatchlistInviteLink({
      actorUserId: outsider.id, baseUrl: 'https://moviecal.test',
      repository: outsiderRepository, watchlistId: listId,
    })).rejects.toThrow();
    const denied = await outsider.client.rpc('rotate_watchlist_invite_link', {
      target_watchlist_id: listId, new_token_hash: hashWatchlistInviteToken(randomUUID()),
    });
    expect(denied.error).not.toBeNull();
    expect((await links()).find((link) => link.token_hash === firstHash)?.revoked_at).toBeNull();

    const [one, two] = await Promise.all([create(), create()]);
    expect(one.inviteUrl).not.toBe(two.inviteUrl);
    expect((await links()).filter((link) => link.revoked_at === null)).toHaveLength(1);

    const otherHash = hashWatchlistInviteToken(randomUUID());
    expect((await owner.client.rpc('rotate_watchlist_invite_link', {
      target_watchlist_id: secondListId, new_token_hash: otherHash,
    })).error).toBeNull();
    const beforeFailure = (await links()).find((link) => link.revoked_at === null)!;
    const failed = await owner.client.rpc('rotate_watchlist_invite_link', {
      target_watchlist_id: listId, new_token_hash: otherHash,
    });
    expect(failed.error).not.toBeNull();
    expect((await links()).find((link) => link.token_hash === beforeFailure.token_hash)?.revoked_at)
      .toBeNull();

    const duplicate = await owner.client.from('watchlist_invite_links').insert({
      created_by_user_id: owner.id, token_hash: hashWatchlistInviteToken(randomUUID()),
      watchlist_id: listId,
    });
    expect(duplicate.error?.code).toBe('23505');

    const revoked = await owner.client.rpc('rotate_watchlist_invite_link', {
      target_watchlist_id: listId, new_token_hash: null,
    });
    expect(revoked.error).toBeNull();
    expect(revoked.data).toBeNull();
    await create();
    await revokeSharedWatchlistInviteLink({
      actorUserId: owner.id, repository, watchlistId: listId,
    });
    expect((await links()).filter((link) => link.revoked_at === null)).toHaveLength(0);
  }, 60_000);
});
