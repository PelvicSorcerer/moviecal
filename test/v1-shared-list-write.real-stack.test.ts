import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as create } from '../src/app/api/v1/watchlists/route';
import { PATCH as rename } from '../src/app/api/v1/watchlists/[watchlistId]/route';
import type { Database } from '../src/lib/supabase/database';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const options = { auth: { autoRefreshToken: false, persistSession: false } };
const roles = ['owner', 'editor', 'pending', 'outsider'] as const;
type Role = typeof roles[number];
const actors = new Map<Role, { id: string; token: string }>();
const admin = createClient<Database>(url, serviceKey, options);
const createdIds: string[] = [];
let listId = '';
const reachable = await fetch(`${url}/rest/v1/`, { signal: AbortSignal.timeout(3000) })
  .then(() => true, () => false);

// CI must actually exercise these probes. Local runs may skip without a stack.
describe.skipIf(!reachable && !process.env.CI)('MOV-341 disposable bearer shared-list create/rename', () => {
  beforeAll(async () => {
    expect(reachable, 'real-stack requires a reachable disposable Supabase').toBe(true);
    const runId = randomUUID();
    for (const role of roles) {
      const email = `mov341-${role}-${runId}@moviecal.test`;
      const password = `Moviecal-${runId}-Aa1!`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      const id = created.data.user!.id;
      actors.set(role, { id, token: '' });
      const signed = await createClient<Database>(url, anonKey, options)
        .auth.signInWithPassword({ email, password });
      expect(signed.error).toBeNull();
      actors.set(role, { id, token: signed.data.session!.access_token });
    }
  }, 30000);

  afterAll(async () => {
    for (const id of createdIds) {
      expect((await admin.from('watchlists').delete().eq('id', id)).error).toBeNull();
    }
    for (const actor of actors.values()) {
      expect((await admin.auth.admin.deleteUser(actor.id)).error).toBeNull();
    }
  });

  function call(method: 'POST' | 'PATCH', token: string, body: unknown, id?: string) {
    const request = new Request(`https://moviecal.test/api/v1/watchlists${id ? `/${id}` : ''}`, {
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method,
    });

    return id
      ? rename(request, { params: Promise.resolve({ watchlistId: id }) })
      : create(request);
  }

  async function storedName(id: string) {
    const row = await admin.from('watchlists').select('name').eq('id', id).single();
    expect(row.error).toBeNull();

    return row.data!.name;
  }

  it('creates a shared list owned by the caller and rejects invalid names', async () => {
    const owner = actors.get('owner')!;
    const response = await call('POST', owner.token, { name: '  Real   stack ' });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.watchlist).toMatchObject({
      canEdit: true, kind: 'shared', name: 'Real stack', ownerUserId: owner.id, role: 'owner',
    });
    listId = body.watchlist.id;
    createdIds.push(listId);
    // Accepted editor / pending invitee memberships for the role checks below.
    for (const role of ['editor', 'pending'] as const) {
      const inserted = await admin.from('watchlist_memberships').insert({
        watchlist_id: listId, user_id: actors.get(role)!.id, role: 'editor',
        accepted_at: role === 'editor' ? new Date().toISOString() : null,
      });
      expect(inserted.error).toBeNull();
    }

    for (const name of ['   ', 'x'.repeat(81)]) {
      expect((await call('POST', owner.token, { name })).status).toBe(400);
    }
  });

  it.each(['owner', 'editor'] as const)('lets the %s rename the shared list', async (role) => {
    const response = await call('PATCH', actors.get(role)!.token, { name: `Renamed by ${role}` }, listId);

    expect(response.status).toBe(200);
    expect((await response.json()).watchlist).toMatchObject({ id: listId, name: `Renamed by ${role}`, role });
    expect(await storedName(listId)).toBe(`Renamed by ${role}`);
  });

  it.each(['pending', 'outsider'] as const)('refuses %s without disclosure or write', async (role) => {
    const before = await storedName(listId);
    const response = await call('PATCH', actors.get(role)!.token, { name: 'Hijack' }, listId);
    const text = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(text)).toEqual({ error: 'Watchlist not found.' });
    expect(text).not.toContain(before);
    expect(await storedName(listId)).toBe(before);
  });

  it('rejects invalid rename names and personal-list renames', async () => {
    const owner = actors.get('owner')!;
    const before = await storedName(listId);

    expect((await call('PATCH', owner.token, { name: '' }, listId)).status).toBe(400);
    expect((await call('PATCH', owner.token, { name: 'x'.repeat(81) }, listId)).status).toBe(400);
    expect(await storedName(listId)).toBe(before);

    const personal = await admin.from('watchlists').select('id, name').eq('owner_user_id', owner.id).eq('kind', 'personal');
    expect(personal.error).toBeNull();
    for (const row of personal.data ?? []) {
      expect((await call('PATCH', owner.token, { name: 'Nope' }, row.id)).status).toBe(404);
    }
  });

  it('rejects an invalid bearer token', async () => {
    expect((await call('POST', 'invalid-token', { name: 'x' })).status).toBe(401);
    expect((await call('PATCH', 'invalid-token', { name: 'x' }, listId)).status).toBe(401);
  });
});
