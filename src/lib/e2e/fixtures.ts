import type { User } from '@supabase/supabase-js';
import {
  createAccessTokenCookieOptions,
  createExpiredCookieOptions,
  type CookieValueReader,
} from '../auth/cookies';
import type { NormalizedMovieDetail, NormalizedMovieSummary } from '../tmdb/client';
import type {
  WatchlistInviteLink,
  WatchlistItem,
  WatchlistMember,
  WatchlistSummary,
} from '../watchlist';

export const E2E_AUTH_COOKIE = 'moviecal-e2e-auth';
export const E2E_USER_COOKIE = 'moviecal-e2e-user';
export const E2E_WATCHLIST_COOKIE = 'moviecal-e2e-watchlist';
export const E2E_WATCHLISTS_COOKIE = 'moviecal-e2e-watchlists';
export const E2E_SHARED_STATE_COOKIE = 'moviecal-e2e-shared-state';
export const E2E_CALENDAR_TOKEN_COOKIE = 'moviecal-e2e-calendar-token';
const E2E_CALENDAR_TOKEN_PREFIX = 'e2e-calendar-token';
export const E2E_PERSONAL_WATCHLIST_ID = 'e2e-personal-watchlist';
const E2E_PERSONAL_WATCHLIST_ID_PREFIX = 'e2e-personal-watchlist';

const E2E_AUTHENTICATED_VALUE = 'authenticated';
const E2E_COOKIE_MAX_AGE_SECONDS = 60 * 60;
export const E2E_DEFAULT_CALENDAR_TOKEN = 'e2e-calendar-token-initial-1234567890';

interface CookieWriter {
  cookies: {
    set(...args: any[]): unknown;
  };
}

type E2EWatchlistItemsByWatchlist = Record<string, WatchlistItem[]>;

export const E2E_USER: User = {
  id: 'e2e-user',
  email: 'e2e@example.com',
  app_metadata: {
    provider: 'e2e',
  },
  aud: 'authenticated',
  created_at: '2026-06-18T00:00:00.000Z',
  user_metadata: {
    label: 'Playwright smoke user',
  },
};

export const E2E_COLLABORATOR_USER: User = {
  id: 'e2e-collaborator-user',
  email: 'friend@example.com',
  app_metadata: {
    provider: 'e2e',
  },
  aud: 'authenticated',
  created_at: '2026-06-18T00:00:00.000Z',
  user_metadata: {
    label: 'Playwright collaborator user',
  },
};

const E2E_USERS = [E2E_USER, E2E_COLLABORATOR_USER];

export interface E2ESharedState {
  inviteLinks: WatchlistInviteLinkWithToken[];
  memberships: WatchlistMember[];
}

export interface WatchlistInviteLinkWithToken extends WatchlistInviteLink {
  token: string;
}

export const E2E_SESSION = {
  accessToken: 'e2e-access-token',
  expiresIn: E2E_COOKIE_MAX_AGE_SECONDS,
  refreshToken: 'e2e-refresh-token',
};

const MOVIE_FIXTURES: Record<number, NormalizedMovieDetail> = {
  603: {
    tmdbId: 603,
    title: 'The Matrix',
    releaseDate: '1999-03-31',
    posterPath: '/matrix.jpg',
    overview: 'A hacker discovers the truth.',
    rawJson: {
      id: 603,
      title: 'The Matrix',
      release_date: '1999-03-31',
      poster_path: '/matrix.jpg',
      overview: 'A hacker discovers the truth.',
    },
  },
  27205: {
    tmdbId: 27205,
    title: 'Inception',
    releaseDate: '2010-07-16',
    posterPath: '/inception.jpg',
    overview: 'A thief steals secrets through shared dreams.',
    rawJson: {
      id: 27205,
      title: 'Inception',
      release_date: '2010-07-16',
      poster_path: '/inception.jpg',
      overview: 'A thief steals secrets through shared dreams.',
    },
  },
};

const MOVIE_ADDED_AT: Record<number, string> = {
  603: '2026-06-18T12:00:00.000Z',
  27205: '2026-06-18T12:05:00.000Z',
};

export function isE2ETestModeEnabled(): boolean {
  return process.env.MOVIECAL_E2E_TEST_MODE === '1';
}

export function hasE2EAuthenticatedSession(reader: CookieValueReader): boolean {
  return isE2ETestModeEnabled()
    && reader.get(E2E_AUTH_COOKIE)?.value === E2E_AUTHENTICATED_VALUE;
}

export function findE2EUserByEmail(email: string): User | null {
  return E2E_USERS.find((user) => user.email === email) ?? null;
}

export function findE2EUserById(userId: string): User | null {
  return E2E_USERS.find((user) => user.id === userId) ?? null;
}

function isE2EUser(value: unknown): value is User {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { email?: unknown }).email === 'string';
}

export function readE2EUser(reader: CookieValueReader): User {
  if (!isE2ETestModeEnabled()) {
    return E2E_USER;
  }

  const rawValue = reader.get(E2E_USER_COOKIE)?.value;

  if (!rawValue) {
    return E2E_USER;
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;

    return isE2EUser(parsedValue) ? parsedValue : E2E_USER;
  } catch {
    return E2E_USER;
  }
}

export function getE2EPersonalWatchlistId(userId: string): string {
  return userId === E2E_USER.id
    ? E2E_PERSONAL_WATCHLIST_ID
    : `${E2E_PERSONAL_WATCHLIST_ID_PREFIX}-${userId}`;
}

export function getE2EMovieFixture(
  tmdbId: number,
): NormalizedMovieDetail | null {
  return MOVIE_FIXTURES[tmdbId] ?? null;
}

export function getE2EMovieSummaries(
  tmdbIds: number[],
): NormalizedMovieSummary[] {
  return tmdbIds.flatMap((tmdbId) => {
    const movie = getE2EMovieFixture(tmdbId);

    return movie
      ? [
          {
            tmdbId: movie.tmdbId,
            title: movie.title,
            releaseDate: movie.releaseDate,
            posterPath: movie.posterPath,
            overview: movie.overview,
          },
        ]
      : [];
  });
}

export function createE2EWatchlistItem(tmdbId: number): WatchlistItem {
  const movie = getE2EMovieFixture(tmdbId);

  if (!movie) {
    throw new Error(`Missing E2E movie fixture for tmdbId ${tmdbId}.`);
  }

  return {
    id: `e2e-watchlist-item-${tmdbId}`,
    addedAt: MOVIE_ADDED_AT[tmdbId] ?? MOVIE_ADDED_AT[603],
    movie: {
      id: tmdbId,
      tmdbId: movie.tmdbId,
      title: movie.title,
      releaseDate: movie.releaseDate,
      overview: movie.overview,
      posterPath: movie.posterPath,
    },
  };
}

function createDefaultE2EWatchlistItemsByWatchlist(
  user: User,
): E2EWatchlistItemsByWatchlist {
  return {
    [getE2EPersonalWatchlistId(user.id)]: [],
  };
}

export function serializeE2EWatchlistItems(
  items: WatchlistItem[] | E2EWatchlistItemsByWatchlist,
): string {
  return JSON.stringify(items);
}

function createDefaultE2EWatchlists(user: User): WatchlistSummary[] {
  return [
    {
      canEdit: true,
      id: getE2EPersonalWatchlistId(user.id),
      kind: 'personal',
      name: 'My watchlist',
      ownerUserId: user.id,
    },
  ];
}

function isWatchlistItem(value: unknown): value is WatchlistItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const item = value as Partial<WatchlistItem>;
  const movie = item.movie as WatchlistItem['movie'] | undefined;

  return typeof item.id === 'string'
    && typeof item.addedAt === 'string'
    && typeof movie?.id === 'number'
    && typeof movie.tmdbId === 'number'
    && typeof movie.title === 'string';
}

function isWatchlistItemsByWatchlist(
  value: unknown,
): value is E2EWatchlistItemsByWatchlist {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((items) => (
    Array.isArray(items) && items.every(isWatchlistItem)
  ));
}

export function readE2EWatchlistItems(reader: CookieValueReader): WatchlistItem[] {
  return readE2EWatchlistItemsForWatchlist(
    reader,
    getE2EPersonalWatchlistId(readE2EUser(reader).id),
  );
}

export function readE2EWatchlistItemsByWatchlist(
  reader: CookieValueReader,
): E2EWatchlistItemsByWatchlist {
  const user = readE2EUser(reader);

  if (!isE2ETestModeEnabled()) {
    return createDefaultE2EWatchlistItemsByWatchlist(user);
  }

  const rawValue = reader.get(E2E_WATCHLIST_COOKIE)?.value;

  if (!rawValue) {
    return createDefaultE2EWatchlistItemsByWatchlist(user);
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;

    if (Array.isArray(parsedValue)) {
      return {
        [getE2EPersonalWatchlistId(user.id)]: parsedValue.filter(isWatchlistItem),
      };
    }

    if (isWatchlistItemsByWatchlist(parsedValue)) {
      return {
        ...createDefaultE2EWatchlistItemsByWatchlist(user),
        ...parsedValue,
      };
    }

    return createDefaultE2EWatchlistItemsByWatchlist(user);
  } catch {
    return createDefaultE2EWatchlistItemsByWatchlist(user);
  }
}

export function readE2EWatchlistItemsForWatchlist(
  reader: CookieValueReader,
  watchlistId: string,
): WatchlistItem[] {
  return readE2EWatchlistItemsByWatchlist(reader)[watchlistId] ?? [];
}

function isWatchlistSummary(value: unknown): value is WatchlistSummary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const watchlist = value as Partial<WatchlistSummary>;

  return typeof watchlist.id === 'string'
    && typeof watchlist.canEdit === 'boolean'
    && typeof watchlist.name === 'string'
    && typeof watchlist.ownerUserId === 'string'
    && (watchlist.kind === 'personal' || watchlist.kind === 'shared');
}

export function serializeE2EWatchlists(watchlists: WatchlistSummary[]): string {
  return JSON.stringify(watchlists);
}

export function readStoredE2EWatchlists(reader: CookieValueReader): WatchlistSummary[] {
  if (!isE2ETestModeEnabled()) {
    return [];
  }

  const user = readE2EUser(reader);
  const rawValue = reader.get(E2E_WATCHLISTS_COOKIE)?.value;

  if (!rawValue) {
    return createDefaultE2EWatchlists(user);
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;
    const watchlists = Array.isArray(parsedValue)
      ? parsedValue.filter(isWatchlistSummary)
      : [];

    return watchlists.some((watchlist) => watchlist.kind === 'personal')
      ? watchlists
      : [...createDefaultE2EWatchlists(user), ...watchlists];
  } catch {
    return createDefaultE2EWatchlists(user);
  }
}

export function readE2EWatchlists(reader: CookieValueReader): WatchlistSummary[] {
  if (!isE2ETestModeEnabled()) {
    return [];
  }

  const user = readE2EUser(reader);
  const sharedState = readE2ESharedState(reader);

  return readStoredE2EWatchlists(reader).filter((watchlist) => {
    if (watchlist.kind === 'personal') {
      return watchlist.ownerUserId === user.id;
    }

    return watchlist.ownerUserId === user.id
      || sharedState.memberships.some(
        (membership) => membership.watchlistId === watchlist.id
          && membership.userId === user.id
          && membership.acceptedAt,
      );
  }).map((watchlist) => (
    watchlist.ownerUserId === user.id
      ? {
          ...watchlist,
          canEdit: true,
        }
      : watchlist
  ));
}

export function createE2ESharedWatchlist(
  name: string,
  existingCount: number,
  ownerUserIdOrCanEdit: string | boolean = E2E_USER.id,
  canEdit = true,
): WatchlistSummary {
  const ownerUserId =
    typeof ownerUserIdOrCanEdit === 'string'
      ? ownerUserIdOrCanEdit
      : E2E_USER.id;
  const resolvedCanEdit =
    typeof ownerUserIdOrCanEdit === 'boolean'
      ? ownerUserIdOrCanEdit
      : canEdit;

  return {
    canEdit: resolvedCanEdit,
    id: `e2e-shared-watchlist-${existingCount + 1}`,
    kind: 'shared',
    name,
    ownerUserId,
  };
}

export function findE2EWatchlist(
  reader: CookieValueReader,
  watchlistId: string,
): WatchlistSummary | null {
  return readE2EWatchlists(reader).find((watchlist) => watchlist.id === watchlistId) ?? null;
}

export function addE2EWatchlistItemToTarget(
  reader: CookieValueReader,
  watchlistId: string,
  tmdbId: number,
): { created: boolean; item: WatchlistItem; itemsByWatchlist: E2EWatchlistItemsByWatchlist } {
  const itemsByWatchlist = readE2EWatchlistItemsByWatchlist(reader);
  const existingItems = itemsByWatchlist[watchlistId] ?? [];
  const existingItem = existingItems.find((item) => item.movie.tmdbId === tmdbId);

  if (existingItem) {
    return {
      created: false,
      item: existingItem,
      itemsByWatchlist,
    };
  }

  const nextItem = createE2EWatchlistItem(tmdbId);

  return {
    created: true,
    item: nextItem,
    itemsByWatchlist: {
      ...itemsByWatchlist,
      [watchlistId]: [...existingItems, nextItem],
    },
  };
}

export function removeE2EWatchlistItemFromTarget(
  reader: CookieValueReader,
  watchlistId: string,
  itemId: string,
): { deleted: boolean; itemsByWatchlist: E2EWatchlistItemsByWatchlist } {
  const itemsByWatchlist = readE2EWatchlistItemsByWatchlist(reader);
  const existingItems = itemsByWatchlist[watchlistId] ?? [];
  const nextItems = existingItems.filter((item) => item.id !== itemId);

  if (nextItems.length === existingItems.length) {
    return {
      deleted: false,
      itemsByWatchlist,
    };
  }

  return {
    deleted: true,
    itemsByWatchlist: {
      ...itemsByWatchlist,
      [watchlistId]: nextItems,
    },
  };
}

export function createE2EWatchlistMember(args: {
  acceptedAt?: string | null;
  id?: string;
  invitedByUserId?: string | null;
  role?: WatchlistMember['role'];
  userId: string;
  watchlistId: string;
}): WatchlistMember {
  return {
    acceptedAt: args.acceptedAt ?? new Date().toISOString(),
    id: args.id ?? `e2e-membership-${args.watchlistId}-${args.userId}`,
    invitedByUserId: args.invitedByUserId ?? E2E_USER.id,
    role: args.role ?? 'editor',
    userId: args.userId,
    watchlistId: args.watchlistId,
  };
}

export function createE2EWatchlistInviteLink(args: {
  createdAt?: string;
  createdByUserId?: string;
  expiresAt?: string | null;
  id?: string;
  revokedAt?: string | null;
  token: string;
  watchlistId: string;
}): WatchlistInviteLinkWithToken {
  return {
    createdAt: args.createdAt ?? new Date().toISOString(),
    createdByUserId: args.createdByUserId ?? E2E_USER.id,
    expiresAt: args.expiresAt ?? null,
    id: args.id ?? `e2e-invite-${args.watchlistId}`,
    revokedAt: args.revokedAt ?? null,
    token: args.token,
    watchlistId: args.watchlistId,
  };
}

function isWatchlistMember(value: unknown): value is WatchlistMember {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const member = value as Partial<WatchlistMember>;

  return typeof member.id === 'string'
    && typeof member.userId === 'string'
    && (member.role === 'owner' || member.role === 'editor')
    && (
      typeof member.acceptedAt === 'string'
      || member.acceptedAt === null
      || member.acceptedAt === undefined
    )
    && (
      typeof member.invitedByUserId === 'string'
      || member.invitedByUserId === null
      || member.invitedByUserId === undefined
    );
}

function isWatchlistInviteLink(value: unknown): value is WatchlistInviteLinkWithToken {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const inviteLink = value as Partial<WatchlistInviteLinkWithToken>;

  return typeof inviteLink.id === 'string'
    && typeof inviteLink.watchlistId === 'string'
    && typeof inviteLink.createdByUserId === 'string'
    && typeof inviteLink.createdAt === 'string'
    && typeof inviteLink.token === 'string'
    && (
      typeof inviteLink.expiresAt === 'string'
      || inviteLink.expiresAt === null
      || inviteLink.expiresAt === undefined
    )
    && (
      typeof inviteLink.revokedAt === 'string'
      || inviteLink.revokedAt === null
      || inviteLink.revokedAt === undefined
    );
}

export function serializeE2ESharedState(state: E2ESharedState): string {
  return JSON.stringify(state);
}

export function readE2ESharedState(reader: CookieValueReader): E2ESharedState {
  if (!isE2ETestModeEnabled()) {
    return {
      inviteLinks: [],
      memberships: [],
    };
  }

  const rawValue = reader.get(E2E_SHARED_STATE_COOKIE)?.value;

  if (!rawValue) {
    return {
      inviteLinks: [],
      memberships: [],
    };
  }

  try {
    const parsedValue = JSON.parse(rawValue) as {
      inviteLinks?: unknown;
      memberships?: unknown;
    };

    return {
      inviteLinks: Array.isArray(parsedValue.inviteLinks)
        ? parsedValue.inviteLinks.filter(isWatchlistInviteLink)
        : [],
      memberships: Array.isArray(parsedValue.memberships)
        ? parsedValue.memberships.filter(isWatchlistMember)
        : [],
    };
  } catch {
    return {
      inviteLinks: [],
      memberships: [],
    };
  }
}

export function readE2ECalendarToken(reader: CookieValueReader): string {
  if (!isE2ETestModeEnabled()) {
    return E2E_DEFAULT_CALENDAR_TOKEN;
  }

  return reader.get(E2E_CALENDAR_TOKEN_COOKIE)?.value ?? E2E_DEFAULT_CALENDAR_TOKEN;
}

export function createSeededE2ECalendarToken(seed: string): string {
  return `${E2E_CALENDAR_TOKEN_PREFIX}-${seed}-initial`;
}

export function createNextE2ECalendarToken(currentToken: string): string {
  return currentToken.endsWith('-initial')
    ? `${currentToken.slice(0, -'-initial'.length)}-rotated`
    : currentToken;
}

export function setE2EAuthCookie(response: CookieWriter, user: User = E2E_USER): void {
  response.cookies.set(
    E2E_AUTH_COOKIE,
    E2E_AUTHENTICATED_VALUE,
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
  response.cookies.set(
    E2E_USER_COOKIE,
    JSON.stringify(user),
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
}

export function setE2EWatchlistCookie(
  response: CookieWriter,
  items: WatchlistItem[] | E2EWatchlistItemsByWatchlist,
): void {
  response.cookies.set(
    E2E_WATCHLIST_COOKIE,
    serializeE2EWatchlistItems(items),
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
}

export function setE2EWatchlistsCookie(
  response: CookieWriter,
  watchlists: WatchlistSummary[],
): void {
  response.cookies.set(
    E2E_WATCHLISTS_COOKIE,
    serializeE2EWatchlists(watchlists),
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
}

export function setE2ESharedStateCookie(
  response: CookieWriter,
  state: E2ESharedState,
): void {
  response.cookies.set(
    E2E_SHARED_STATE_COOKIE,
    serializeE2ESharedState(state),
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
}

export function setE2ECalendarTokenCookie(
  response: CookieWriter,
  token: string,
): void {
  response.cookies.set(
    E2E_CALENDAR_TOKEN_COOKIE,
    token,
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
}

export function clearE2EStateCookies(response: CookieWriter): void {
  response.cookies.set(E2E_AUTH_COOKIE, '', createExpiredCookieOptions());
  response.cookies.set(E2E_USER_COOKIE, '', createExpiredCookieOptions());
  response.cookies.set(E2E_WATCHLIST_COOKIE, '', createExpiredCookieOptions());
  response.cookies.set(E2E_WATCHLISTS_COOKIE, '', createExpiredCookieOptions());
  response.cookies.set(E2E_SHARED_STATE_COOKIE, '', createExpiredCookieOptions());
  response.cookies.set(E2E_CALENDAR_TOKEN_COOKIE, '', createExpiredCookieOptions());
}
