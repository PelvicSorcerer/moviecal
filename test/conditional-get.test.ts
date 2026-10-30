import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createConditionalJsonResponse } from '../src/lib/api/conditional-get';

function request(ifNoneMatch?: string): Request {
  return new Request('https://moviecal.test/api/v1/watchlist', {
    headers: ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {},
  });
}

describe('conditional JSON GET', () => {
  it('hashes the exact UTF-8 response bytes as a quoted SHA-256', async () => {
    const value = { items: [{ title: 'Amélie' }] };
    const response = createConditionalJsonResponse(request(), value);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toBe(JSON.stringify(value));
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('etag')).toBe(
      `"${createHash('sha256').update(body).digest('hex')}"`,
    );
    expect(createConditionalJsonResponse(request(), value).headers.get('etag'))
      .toBe(response.headers.get('etag'));
  });

  it('includes every page field and item in the validator', () => {
    const value = { items: [{ id: 'first' }], page: { limit: 1, nextCursor: 'next' } };
    const etag = createConditionalJsonResponse(request(), value).headers.get('etag');

    for (const changed of [
      { ...value, items: [{ id: 'second' }] },
      { ...value, page: { ...value.page, nextCursor: null } },
      { ...value, page: { ...value.page, limit: 2 } },
    ]) {
      const response = createConditionalJsonResponse(request(etag!), changed);

      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).not.toBe(etag);
    }
  });

  it.each(['strong', 'weak', 'list', 'wildcard'])(
    'returns a bodyless 304 for a %s match',
    async (kind) => {
      const value = { items: [] };
      const etag = createConditionalJsonResponse(request(), value).headers.get('etag')!;
      const validators: Record<string, string> = {
        strong: etag,
        weak: `W/${etag}`,
        list: ` "other", W/${etag} , "last" `,
        wildcard: ' * ',
      };
      const response = createConditionalJsonResponse(request(validators[kind]), value);

      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe('');
      expect(response.headers.get('etag')).toBe(etag);
      expect(response.headers.get('cache-control')).toBe('private, no-cache');
    },
  );

  it.each(['"other"', 'invalid', 'w/"other"', '"prefix,other"'])(
    'returns JSON for a non-matching validator %s',
    async (validator) => {
      const response = createConditionalJsonResponse(request(validator), { items: [] });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [] });
    },
  );
});
