import { describe, expect, it, vi } from 'vitest';

import {
  normalizeSharedWatchlistName,
  renameSharedWatchlist,
  WatchlistAccessError,
  WatchlistInputError,
  WatchlistNotFoundError,
  type WatchlistAccessResult,
  type WatchlistSummary,
} from '../src/lib/watchlist';
import { buildWatchlistSummary, createWatchlistRepository } from './support';

const SHARED = buildWatchlistSummary({
  id: 'shared-1',
  kind: 'shared',
  name: 'Friday movie night',
  ownerUserId: 'owner',
});
const PERSONAL = buildWatchlistSummary({
  id: 'personal-1',
  kind: 'personal',
  name: 'My watchlist',
  ownerUserId: 'owner',
});

const ACCESS_BY_ACTOR: Record<string, WatchlistAccessResult> = {
  owner: { status: 'authorized', watchlist: SHARED, canEdit: true },
  editor: { status: 'authorized', watchlist: SHARED, canEdit: true },
  viewer: { status: 'authorized', watchlist: SHARED, canEdit: false },
  pending: { status: 'forbidden' },
  outsider: { status: 'forbidden' },
};

/** In-memory repository whose last successful rename wins. */
function createRenameRepository(watchlists: WatchlistSummary[] = [SHARED, PERSONAL]) {
  const byId = new Map(watchlists.map((watchlist) => [watchlist.id, { ...watchlist }]));
  const renameWatchlist = vi.fn(
    async (args: { name: string; watchlistId: string }) => {
      const watchlist = byId.get(args.watchlistId);

      if (!watchlist || watchlist.kind !== 'shared') {
        return null;
      }

      watchlist.name = args.name;

      return { ...watchlist };
    },
  );

  return {
    byId,
    renameWatchlist,
    repository: createWatchlistRepository({
      async getWatchlistAccess(actorUserId, watchlistId) {
        const watchlist = byId.get(watchlistId);

        if (!watchlist) {
          return { status: 'not_found' };
        }

        const access = ACCESS_BY_ACTOR[actorUserId] ?? { status: 'forbidden' };

        return access.status === 'authorized'
          ? { ...access, watchlist: { ...watchlist, canEdit: access.canEdit } }
          : access;
      },
      renameWatchlist,
    }),
  };
}

describe('normalizeSharedWatchlistName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeSharedWatchlistName('  Friday \t  movie\nnight ')).toBe(
      'Friday movie night',
    );
  });

  it('accepts exactly 80 characters and rejects 81', () => {
    expect(normalizeSharedWatchlistName('a'.repeat(80))).toHaveLength(80);
    expect(() => normalizeSharedWatchlistName('a'.repeat(81))).toThrow(
      WatchlistInputError,
    );
  });

  it.each(['', '   ', '\n\t'])('rejects the blank name %j', (name) => {
    expect(() => normalizeSharedWatchlistName(name)).toThrow(WatchlistInputError);
  });
});

describe('renameSharedWatchlist', () => {
  it.each(['owner', 'editor'])(
    'lets the %s rename and returns the committed name',
    async (actorUserId) => {
      const { byId, repository, renameWatchlist } = createRenameRepository();

      await expect(
        renameSharedWatchlist({
          actorUserId,
          name: '  Saturday   picks ',
          repository,
          watchlistId: SHARED.id,
        }),
      ).resolves.toEqual({ ...SHARED, name: 'Saturday picks', canEdit: true });
      expect(renameWatchlist).toHaveBeenCalledWith({
        name: 'Saturday picks',
        watchlistId: SHARED.id,
      });
      expect(byId.get(SHARED.id)?.name).toBe('Saturday picks');
    },
  );

  it.each(['pending', 'outsider', 'viewer'])(
    'refuses the %s without writing or naming the list',
    async (actorUserId) => {
      const { byId, repository, renameWatchlist } = createRenameRepository();
      const error = await renameSharedWatchlist({
        actorUserId,
        name: 'Hijacked',
        repository,
        watchlistId: SHARED.id,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WatchlistAccessError);
      expect((error as Error).message).not.toContain(SHARED.name);
      expect(renameWatchlist).not.toHaveBeenCalled();
      expect(byId.get(SHARED.id)?.name).toBe(SHARED.name);
    },
  );

  it('reports an unknown list as not found without writing', async () => {
    const { repository, renameWatchlist } = createRenameRepository();

    await expect(
      renameSharedWatchlist({
        actorUserId: 'owner',
        name: 'Anything',
        repository,
        watchlistId: 'missing',
      }),
    ).rejects.toBeInstanceOf(WatchlistNotFoundError);
    expect(renameWatchlist).not.toHaveBeenCalled();
  });

  it('never renames a personal list, even for its owner', async () => {
    const { byId, repository, renameWatchlist } = createRenameRepository();

    await expect(
      renameSharedWatchlist({
        actorUserId: 'owner',
        name: 'Renamed personal',
        repository,
        watchlistId: PERSONAL.id,
      }),
    ).rejects.toBeInstanceOf(WatchlistAccessError);
    expect(renameWatchlist).not.toHaveBeenCalled();
    expect(byId.get(PERSONAL.id)?.name).toBe('My watchlist');
  });

  it.each(['', '   ', 'x'.repeat(81)])(
    'rejects the invalid name %j without writing',
    async (name) => {
      const { byId, repository, renameWatchlist } = createRenameRepository();

      await expect(
        renameSharedWatchlist({
          actorUserId: 'editor',
          name,
          repository,
          watchlistId: SHARED.id,
        }),
      ).rejects.toBeInstanceOf(WatchlistInputError);
      expect(renameWatchlist).not.toHaveBeenCalled();
      expect(byId.get(SHARED.id)?.name).toBe(SHARED.name);
    },
  );

  it('answers an outsider with an access error before validating the name', async () => {
    const { repository } = createRenameRepository();

    await expect(
      renameSharedWatchlist({
        actorUserId: 'outsider',
        name: '',
        repository,
        watchlistId: SHARED.id,
      }),
    ).rejects.toBeInstanceOf(WatchlistAccessError);
  });

  it('refuses when the write matches no row because access changed mid-flight', async () => {
    const { repository } = createRenameRepository();
    const racing = createWatchlistRepository({
      ...repository,
      async renameWatchlist() {
        return null;
      },
    });

    await expect(
      renameSharedWatchlist({
        actorUserId: 'editor',
        name: 'Too late',
        repository: racing,
        watchlistId: SHARED.id,
      }),
    ).rejects.toBeInstanceOf(WatchlistAccessError);
  });

  it('resolves concurrent valid renames to the last committed name', async () => {
    const { byId, repository } = createRenameRepository();
    const first = renameSharedWatchlist({
      actorUserId: 'owner',
      name: 'First',
      repository,
      watchlistId: SHARED.id,
    });
    const second = renameSharedWatchlist({
      actorUserId: 'editor',
      name: 'Second',
      repository,
      watchlistId: SHARED.id,
    });
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.name)).toEqual(['First', 'Second']);
    expect(byId.get(SHARED.id)?.name).toBe('Second');
  });
});
