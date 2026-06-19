import { describe, expect, it, vi } from 'vitest';

import {
  buildCalendarSubscriptionUrl,
  CalendarTokenDataError,
  generateCalendarToken,
  getOrCreateCalendarToken,
  resolveCalendarTokenOwner,
  rotateCalendarToken,
  type CalendarTokenRepository,
  type CalendarTokenRow,
} from '../src/lib/calendar-tokens';

function createRow(overrides: Partial<CalendarTokenRow> = {}): CalendarTokenRow {
  return {
    created_at: '2026-06-19T00:00:00.000Z',
    id: 'token-row-1',
    token: 'existing-token',
    user_id: 'user-1',
    ...overrides,
  };
}

function createRepository(
  overrides: Partial<CalendarTokenRepository> = {},
): CalendarTokenRepository {
  return {
    async findTokenByUserId() {
      return null;
    },
    async findUserIdByToken() {
      return null;
    },
    async insertTokenForUser() {
      return {
        errorCode: null,
        row: createRow(),
      };
    },
    async updateTokenForUser() {
      return {
        errorCode: null,
        row: createRow({ token: 'rotated-token' }),
      };
    },
    ...overrides,
  };
}

describe('calendar token helpers', () => {
  it('generates url-safe tokens with strong length', () => {
    const token = generateCalendarToken(
      ((size: number) => Buffer.alloc(size, 7)) as typeof import('node:crypto').randomBytes,
    );

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
  });

  it('builds the subscription URL from the request origin', () => {
    expect(
      buildCalendarSubscriptionUrl('https://moviecal.example.com', 'token-123'),
    ).toBe('https://moviecal.example.com/api/calendar/token-123');
  });
});

describe('calendar token domain flow', () => {
  it('returns the existing token without regenerating it', async () => {
    const repository = createRepository({
      async findTokenByUserId() {
        return createRow();
      },
    });

    await expect(
      getOrCreateCalendarToken({ repository, userId: 'user-1' }),
    ).resolves.toEqual(createRow());
  });

  it('creates a token when the user does not have one yet', async () => {
    const repository = createRepository({
      async insertTokenForUser(_userId, token) {
        return {
          errorCode: null,
          row: createRow({ token }),
        };
      },
    });

    const row = await getOrCreateCalendarToken({
      repository,
      userId: 'user-1',
    });

    expect(row.user_id).toBe('user-1');
    expect(row.token.length).toBeGreaterThanOrEqual(32);
  });

  it('resolves an insert race by refetching the user token', async () => {
    const repository = createRepository({
      async findTokenByUserId() {
        return createRow({ token: 'raced-token' });
      },
      async insertTokenForUser() {
        return {
          errorCode: '23505',
          row: null,
        };
      },
    });

    await expect(
      getOrCreateCalendarToken({ repository, userId: 'user-1' }),
    ).resolves.toEqual(createRow({ token: 'raced-token' }));
  });

  it('rotates the token for an existing row', async () => {
    const repository = createRepository({
      async findTokenByUserId() {
        return createRow({ token: 'old-token' });
      },
      async updateTokenForUser(_userId, token) {
        return {
          errorCode: null,
          row: createRow({ token }),
        };
      },
    });

    const row = await rotateCalendarToken({
      repository,
      userId: 'user-1',
    });

    expect(row.token).not.toBe('old-token');
  });

  it('creates a token on rotate when no token exists yet', async () => {
    const repository = createRepository({
      async findTokenByUserId() {
        return null;
      },
      async insertTokenForUser(_userId, token) {
        return {
          errorCode: null,
          row: createRow({ token }),
        };
      },
    });

    const row = await rotateCalendarToken({
      repository,
      userId: 'user-1',
    });

    expect(row.token.length).toBeGreaterThanOrEqual(32);
  });

  it('resolves the owner id from a valid token', async () => {
    const repository = createRepository({
      async findUserIdByToken(token) {
        return token === 'valid-token' ? 'user-1' : null;
      },
    });

    await expect(
      resolveCalendarTokenOwner({ repository, token: 'valid-token' }),
    ).resolves.toBe('user-1');
    await expect(
      resolveCalendarTokenOwner({ repository, token: 'missing-token' }),
    ).resolves.toBeNull();
  });

  it('throws a data error when rotation cannot persist', async () => {
    const repository = createRepository({
      async findTokenByUserId() {
        return createRow();
      },
      async updateTokenForUser() {
        return {
          errorCode: null,
          row: null,
        };
      },
    });

    await expect(
      rotateCalendarToken({ repository, userId: 'user-1' }),
    ).rejects.toBeInstanceOf(CalendarTokenDataError);
  });
});
