import { describe, expect, it, vi } from 'vitest';

import {
  acceptWatchlistInvite,
  createSharedWatchlist,
  createSharedWatchlistInviteLink,
  addPersonalWatchlistItem,
  addWatchlistItem,
  getWatchlistDetail,
  getSharedWatchlistInviteLinkStatus,
  listPersonalWatchlistItems,
  listSharedWatchlistMembers,
  listUserWatchlists,
  listWatchlistItems,
  mapWatchlistRow,
  removeSharedWatchlistMember,
  removeWatchlistItem,
  resolveWatchlistInvite,
  WatchlistAccessError,
  WatchlistNotFoundError,
  WatchlistInputError,
  type WatchlistRepository,
  type WatchlistSummary,
} from '../src/lib/watchlist';
import {
  buildWatchlistRow,
  buildWatchlistSummary,
  createWatchlistRepository,
} from './support';

describe('watchlist domain helpers', () => {
  it('maps joined movie metadata into the planned API shape', () => {
    expect(mapWatchlistRow(buildWatchlistRow())).toEqual({
      id: 'watchlist-item-1',
      addedAt: '2026-06-13T05:00:00.000Z',
      movie: {
        id: 42,
        tmdbId: 603,
        title: 'The Matrix',
        releaseDate: '1999-03-31',
        overview: 'A hacker discovers the truth.',
        posterPath: '/matrix.jpg',
      },
    });
  });

  it('lists an explicitly scoped watchlist after checking access', async () => {
    const repository = createWatchlistRepository({
      async getWatchlistAccess(actorUserId, watchlistId) {
        expect(actorUserId).toBe('user-1');
        expect(watchlistId).toBe('personal-watchlist-1');

        return {
          status: 'authorized',
          watchlist: buildWatchlistSummary(),
          canEdit: true,
        };
      },
      async listItemsForWatchlist(watchlistId) {
        expect(watchlistId).toBe('personal-watchlist-1');
        return [buildWatchlistRow()];
      },
    });

    await expect(
      listWatchlistItems({
        actorUserId: 'user-1',
        repository,
        watchlistId: 'personal-watchlist-1',
      }),
    ).resolves.toEqual([
      {
        id: 'watchlist-item-1',
        addedAt: '2026-06-13T05:00:00.000Z',
        movie: {
          id: 42,
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          overview: 'A hacker discovers the truth.',
          posterPath: '/matrix.jpg',
        },
      },
    ]);
  });

  it('returns the authorized watchlist detail contract for a target list', async () => {
    const repository = createWatchlistRepository({
      async getWatchlistAccess() {
        return {
          status: 'authorized',
          watchlist: buildWatchlistSummary({
            id: 'shared-watchlist-1',
            kind: 'shared',
            name: 'Friday movie night',
          }),
          canEdit: true,
        };
      },
      async listItemsForWatchlist(watchlistId) {
        expect(watchlistId).toBe('shared-watchlist-1');
        return [buildWatchlistRow()];
      },
    });

    await expect(
      getWatchlistDetail({
        actorUserId: 'user-1',
        repository,
        watchlistId: 'shared-watchlist-1',
      }),
    ).resolves.toEqual({
      watchlist: buildWatchlistSummary({
        canEdit: true,
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
      }),
      items: [
        {
          id: 'watchlist-item-1',
          addedAt: '2026-06-13T05:00:00.000Z',
          movie: {
            id: 42,
            tmdbId: 603,
            title: 'The Matrix',
            releaseDate: '1999-03-31',
            overview: 'A hacker discovers the truth.',
            posterPath: '/matrix.jpg',
          },
        },
      ],
    });
  });

  it('preserves the current personal watchlist path through the generalized abstraction', async () => {
    const repository = createWatchlistRepository({
      async ensurePersonalWatchlist(userId) {
        expect(userId).toBe('user-1');
        return buildWatchlistSummary({
          id: 'personal-watchlist-1',
        });
      },
      async getWatchlistAccess(actorUserId, watchlistId) {
        expect(actorUserId).toBe('user-1');
        expect(watchlistId).toBe('personal-watchlist-1');
        return {
          status: 'authorized',
          watchlist: buildWatchlistSummary({
            id: 'personal-watchlist-1',
          }),
          canEdit: true,
        };
      },
      async listItemsForWatchlist(watchlistId) {
        expect(watchlistId).toBe('personal-watchlist-1');
        return [buildWatchlistRow()];
      },
    });

    await expect(
      listPersonalWatchlistItems({
        repository,
        userId: 'user-1',
      }),
    ).resolves.toHaveLength(1);
  });

  it('ensures the personal watchlist is present and ordered first in the overview list', async () => {
    const repository = createWatchlistRepository({
      async ensurePersonalWatchlist() {
        return buildWatchlistSummary({
          id: 'personal-watchlist-1',
        });
      },
      async listWatchlistsForUser() {
        return [
          buildWatchlistSummary({
            id: 'shared-watchlist-1',
            kind: 'shared',
            name: 'Friday movie night',
          }),
          buildWatchlistSummary({
            id: 'personal-watchlist-1',
          }),
        ];
      },
    });

    await expect(
      listUserWatchlists({
        repository,
        userId: 'user-1',
      }),
    ).resolves.toEqual([
      buildWatchlistSummary({
        canEdit: true,
        id: 'personal-watchlist-1',
      }),
      buildWatchlistSummary({
        canEdit: true,
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
      }),
    ]);
  });

  it('preserves read-only membership state in the watchlist overview contract', async () => {
    const repository = createWatchlistRepository({
      async ensurePersonalWatchlist() {
        return buildWatchlistSummary({
          id: 'personal-watchlist-1',
        });
      },
      async listWatchlistsForUser() {
        return [
          buildWatchlistSummary({
            id: 'shared-watchlist-readonly',
            kind: 'shared',
            name: 'Curated picks',
            canEdit: false,
          }),
          buildWatchlistSummary({
            id: 'personal-watchlist-1',
          }),
        ];
      },
    });

    await expect(
      listUserWatchlists({
        repository,
        userId: 'user-1',
      }),
    ).resolves.toEqual([
      buildWatchlistSummary({
        id: 'personal-watchlist-1',
      }),
      buildWatchlistSummary({
        id: 'shared-watchlist-readonly',
        kind: 'shared',
        name: 'Curated picks',
        canEdit: false,
      }),
    ]);
  });

  it('creates a shared watchlist with normalized input', async () => {
    const repository = createWatchlistRepository({
      async createWatchlist(args) {
        expect(args).toEqual({
          ownerUserId: 'user-1',
          kind: 'shared',
          name: 'Friday movie night',
        });

        return buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        });
      },
    });

    await expect(
      createSharedWatchlist({
        name: '  Friday   movie night  ',
        repository,
        userId: 'user-1',
      }),
    ).resolves.toEqual(
      buildWatchlistSummary({
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
      }),
    );
  });

  it('resolves only active shared-watchlist invite links', async () => {
    await expect(
      resolveWatchlistInvite({
        repository: createWatchlistRepository({
          async findInviteLinkByTokenHash() {
            return {
              inviteLink: {
                createdAt: '2026-06-20T00:00:00.000Z',
                createdByUserId: 'user-1',
                expiresAt: null,
                id: 'invite-1',
                revokedAt: null,
                watchlistId: 'shared-watchlist-1',
              },
              watchlist: buildWatchlistSummary({
                id: 'shared-watchlist-1',
                kind: 'shared',
                name: 'Friday movie night',
              }),
            };
          },
        }),
        token: 'secret-token',
      }),
    ).resolves.toMatchObject({
      watchlist: {
        id: 'shared-watchlist-1',
        kind: 'shared',
      },
    });

    await expect(
      resolveWatchlistInvite({
        repository: createWatchlistRepository({
          async findInviteLinkByTokenHash() {
            return {
              inviteLink: {
                createdAt: '2026-06-20T00:00:00.000Z',
                createdByUserId: 'user-1',
                expiresAt: null,
                id: 'invite-1',
                revokedAt: '2026-06-21T00:00:00.000Z',
                watchlistId: 'shared-watchlist-1',
              },
              watchlist: buildWatchlistSummary({
                id: 'shared-watchlist-1',
                kind: 'shared',
              }),
            };
          },
        }),
        token: 'secret-token',
      }),
    ).resolves.toBeNull();
  });

  it('creates a shared watchlist invite link for the owner', async () => {
    const revokeInviteLinksForWatchlist = vi.fn();
    const createInviteLink = vi.fn(async () => ({
      createdAt: '2026-06-20T00:00:00.000Z',
      createdByUserId: 'user-1',
      expiresAt: null,
      id: 'invite-1',
      revokedAt: null,
      watchlistId: 'shared-watchlist-1',
    }));

    await expect(
      createSharedWatchlistInviteLink({
        actorUserId: 'user-1',
        baseUrl: 'https://moviecal.test',
        repository: createWatchlistRepository({
          createInviteLink,
          getWatchlistAccess: async () => ({
            status: 'authorized',
            watchlist: buildWatchlistSummary({
              id: 'shared-watchlist-1',
              kind: 'shared',
              ownerUserId: 'user-1',
            }),
            canEdit: true,
          }),
          revokeInviteLinksForWatchlist,
        }),
        watchlistId: 'shared-watchlist-1',
      }),
    ).resolves.toMatchObject({
      watchlist: {
        id: 'shared-watchlist-1',
      },
    });

    expect(revokeInviteLinksForWatchlist).toHaveBeenCalledWith('shared-watchlist-1');
    expect(createInviteLink).toHaveBeenCalledOnce();
  });

  it('accepts a shared watchlist invite for a new member', async () => {
    const acceptInviteMembership = vi.fn();

    await expect(
      acceptWatchlistInvite({
        actorUserId: 'user-2',
        repository: createWatchlistRepository({
          acceptInviteMembership,
          async findInviteLinkByTokenHash() {
            return {
              inviteLink: {
                createdAt: '2026-06-20T00:00:00.000Z',
                createdByUserId: 'user-1',
                expiresAt: null,
                id: 'invite-1',
                revokedAt: null,
                watchlistId: 'shared-watchlist-1',
              },
              watchlist: buildWatchlistSummary({
                id: 'shared-watchlist-1',
                kind: 'shared',
                ownerUserId: 'user-1',
              }),
            };
          },
        }),
        token: 'secret-token',
      }),
    ).resolves.toEqual({
      joined: true,
      watchlist: buildWatchlistSummary({
        id: 'shared-watchlist-1',
        kind: 'shared',
        ownerUserId: 'user-1',
      }),
    });

    expect(acceptInviteMembership).toHaveBeenCalledOnce();
  });

  it('does not create a duplicate membership when the watchlist owner accepts their invite link', async () => {
    const acceptInviteMembership = vi.fn();
    const resolvedInvite = {
      inviteLink: {
        createdAt: '2026-06-20T00:00:00.000Z',
        createdByUserId: 'user-1',
        expiresAt: null,
        id: 'invite-1',
        revokedAt: null,
        watchlistId: 'shared-watchlist-1',
      },
      watchlist: buildWatchlistSummary({
        id: 'shared-watchlist-1',
        kind: 'shared',
        ownerUserId: 'user-1',
      }),
    };

    await expect(
      acceptWatchlistInvite({
        actorUserId: 'user-1',
        repository: createWatchlistRepository({
          acceptInviteMembership,
          async findInviteLinkByTokenHash() {
            return resolvedInvite;
          },
        }),
        token: 'secret-token',
      }),
    ).resolves.toEqual({
      joined: false,
      watchlist: resolvedInvite.watchlist,
    });

    expect(acceptInviteMembership).not.toHaveBeenCalled();
  });

  it('does not create a duplicate membership when an accepted member reuses an invite link', async () => {
    const acceptInviteMembership = vi.fn();
    const resolvedInvite = {
      inviteLink: {
        createdAt: '2026-06-20T00:00:00.000Z',
        createdByUserId: 'user-1',
        expiresAt: null,
        id: 'invite-1',
        revokedAt: null,
        watchlistId: 'shared-watchlist-1',
      },
      watchlist: buildWatchlistSummary({
        id: 'shared-watchlist-1',
        kind: 'shared',
        ownerUserId: 'user-1',
      }),
    };

    await expect(
      acceptWatchlistInvite({
        actorUserId: 'user-2',
        repository: createWatchlistRepository({
          acceptInviteMembership,
          async findInviteLinkByTokenHash() {
            return resolvedInvite;
          },
          async findMembershipForUser() {
            return {
              acceptedAt: '2026-06-20T00:00:00.000Z',
              id: 'membership-1',
              invitedByUserId: 'user-1',
              role: 'editor',
              userId: 'user-2',
              watchlistId: 'shared-watchlist-1',
            };
          },
        }),
        token: 'secret-token',
      }),
    ).resolves.toEqual({
      joined: false,
      watchlist: resolvedInvite.watchlist,
    });

    expect(acceptInviteMembership).not.toHaveBeenCalled();
  });

  it('lists and removes shared watchlist members through owner-only helpers', async () => {
    const repository = createWatchlistRepository({
      async getWatchlistAccess() {
        return {
          status: 'authorized',
          watchlist: buildWatchlistSummary({
            id: 'shared-watchlist-1',
            kind: 'shared',
            ownerUserId: 'user-1',
          }),
          canEdit: true,
        };
      },
      async listMembersForWatchlist() {
        return [
          {
            acceptedAt: '2026-06-20T00:00:00.000Z',
            id: 'membership-1',
            invitedByUserId: 'user-1',
            role: 'editor',
            userId: 'user-2',
          },
        ];
      },
      async removeMembershipFromWatchlist() {
        return true;
      },
    });

    await expect(
      listSharedWatchlistMembers({
        actorUserId: 'user-1',
        repository,
        watchlistId: 'shared-watchlist-1',
      }),
    ).resolves.toHaveLength(2);

    await expect(
      removeSharedWatchlistMember({
        actorUserId: 'user-1',
        membershipId: 'membership-1',
        repository,
        watchlistId: 'shared-watchlist-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('reports whether a shared watchlist currently has an active invite link', async () => {
    await expect(
      getSharedWatchlistInviteLinkStatus({
        actorUserId: 'user-1',
        repository: createWatchlistRepository({
          async getActiveInviteLinkForWatchlist() {
            return {
              createdAt: '2026-06-20T00:00:00.000Z',
              createdByUserId: 'user-1',
              expiresAt: null,
              id: 'invite-1',
              revokedAt: null,
              watchlistId: 'shared-watchlist-1',
            };
          },
          async getWatchlistAccess() {
            return {
              status: 'authorized',
              watchlist: buildWatchlistSummary({
                id: 'shared-watchlist-1',
                kind: 'shared',
                ownerUserId: 'user-1',
              }),
              canEdit: true,
            };
          },
        }),
        watchlistId: 'shared-watchlist-1',
      }),
    ).resolves.toMatchObject({
      id: 'invite-1',
    });
  });

  it('distinguishes forbidden watchlist access from not-found watchlists', async () => {
    await expect(
      listWatchlistItems({
        actorUserId: 'user-2',
        repository: createWatchlistRepository({
          async getWatchlistAccess() {
            return {
              status: 'forbidden',
            };
          },
        }),
        watchlistId: 'personal-watchlist-1',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'WatchlistAccessError',
        reason: 'forbidden',
        status: 403,
      }),
    );

    await expect(
      listWatchlistItems({
        actorUserId: 'user-2',
        repository: createWatchlistRepository({
          async getWatchlistAccess() {
            return {
              status: 'not_found',
            };
          },
        }),
        watchlistId: 'watchlist-missing',
      }),
    ).rejects.toBeInstanceOf(WatchlistNotFoundError);
  });

  it('blocks mutations when the actor lacks edit access', async () => {
    await expect(
      addWatchlistItem({
        actorUserId: 'user-2',
        getMovieDetails: async () => ({
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          posterPath: '/matrix.jpg',
          overview: 'A hacker discovers the truth.',
          rawJson: {
            id: 603,
            title: 'The Matrix',
          },
        }),
        repository: createWatchlistRepository({
          async getWatchlistAccess() {
            return {
              status: 'authorized',
              watchlist: buildWatchlistSummary({
                id: 'shared-watchlist-1',
                kind: 'shared',
              }),
              canEdit: false,
            };
          },
        }),
        tmdbId: 603,
        watchlistId: 'shared-watchlist-1',
      }),
    ).rejects.toBeInstanceOf(WatchlistAccessError);
  });

  it('adds a new watchlist item after upserting movie metadata', async () => {
    const repository = createWatchlistRepository({
      async getWatchlistAccess(actorUserId, watchlistId) {
        expect(actorUserId).toBe('user-1');
        expect(watchlistId).toBe('personal-watchlist-1');
        return {
          status: 'authorized',
          watchlist: buildWatchlistSummary(),
          canEdit: true,
        };
      },
      async upsertMovie(detail) {
        expect(detail.tmdbId).toBe(603);
        return { id: 42 };
      },
      async insertItemForWatchlist(watchlistId, movieId) {
        expect(watchlistId).toBe('personal-watchlist-1');
        expect(movieId).toBe(42);
        return {
          row: buildWatchlistRow(),
          errorCode: null,
        };
      },
    });

    await expect(
      addWatchlistItem({
        actorUserId: 'user-1',
        getMovieDetails: async () => ({
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          posterPath: '/matrix.jpg',
          overview: 'A hacker discovers the truth.',
          rawJson: {
            id: 603,
            title: 'The Matrix',
          },
        }),
        repository,
        tmdbId: 603,
        watchlistId: 'personal-watchlist-1',
      }),
    ).resolves.toEqual({
      created: true,
      item: {
        id: 'watchlist-item-1',
        addedAt: '2026-06-13T05:00:00.000Z',
        movie: {
          id: 42,
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          overview: 'A hacker discovers the truth.',
          posterPath: '/matrix.jpg',
        },
      },
      watchlist: buildWatchlistSummary(),
    });
  });

  it('treats duplicate add attempts as deterministic no-ops within the target watchlist scope', async () => {
    const repository = createWatchlistRepository({
      async insertItemForWatchlist() {
        return {
          row: null,
          errorCode: '23505',
        };
      },
    });

    await expect(
      addPersonalWatchlistItem({
        getMovieDetails: async () => ({
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          posterPath: '/matrix.jpg',
          overview: 'A hacker discovers the truth.',
          rawJson: {
            id: 603,
            title: 'The Matrix',
          },
        }),
        repository,
        tmdbId: 603,
        userId: 'user-1',
      }),
    ).resolves.toMatchObject({
      created: false,
      item: {
        id: 'watchlist-item-1',
      },
      watchlist: {
        id: 'personal-watchlist-1',
      },
    });
  });

  it('rejects invalid tmdb ids before calling TMDb', async () => {
    const getMovieDetails = vi.fn();

    await expect(
      addPersonalWatchlistItem({
        getMovieDetails,
        repository: createWatchlistRepository(),
        tmdbId: 0,
        userId: 'user-1',
      }),
    ).rejects.toBeInstanceOf(WatchlistInputError);

    expect(getMovieDetails).not.toHaveBeenCalled();
  });

  it('rejects blank shared watchlist names before repository writes', async () => {
    await expect(
      createSharedWatchlist({
        name: '   ',
        repository: createWatchlistRepository(),
        userId: 'user-1',
      }),
    ).rejects.toBeInstanceOf(WatchlistInputError);
  });

  it('reports missing watchlist items on delete', async () => {
    await expect(
      removeWatchlistItem({
        actorUserId: 'user-1',
        itemId: 'missing-item',
        repository: createWatchlistRepository({
          async deleteItemByIdForWatchlist() {
            return false;
          },
        }),
        watchlistId: 'personal-watchlist-1',
      }),
    ).rejects.toBeInstanceOf(WatchlistNotFoundError);
  });

  it('exposes list discovery through the repository abstraction', async () => {
    await expect(
      listUserWatchlists({
        repository: createWatchlistRepository({
          async listWatchlistsForUser(userId) {
            expect(userId).toBe('user-1');
            return [
              buildWatchlistSummary(),
              buildWatchlistSummary({
                id: 'shared-watchlist-1',
                kind: 'shared',
                name: 'Movie night',
              }),
            ];
          },
        }),
        userId: 'user-1',
      }),
    ).resolves.toEqual([
      buildWatchlistSummary(),
      buildWatchlistSummary({
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Movie night',
      }),
    ]);
  });
});
