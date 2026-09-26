import { WatchlistAccessError, WatchlistNotFoundError } from './errors';
import { getWatchlistDetail, toUtcIsoString } from './items';
import { paginateById, type Page, type PageRequest } from './pagination';
import { listUserWatchlists } from './shared';
import type {
  WatchlistItem,
  WatchlistKind,
  WatchlistMembershipRole,
  WatchlistRepository,
  WatchlistSummary,
} from './types';


export interface AuthorizedWatchlistView {
  canEdit: boolean;
  id: string;
  kind: WatchlistKind;
  name: string;
  ownerUserId: string;
  role: WatchlistMembershipRole;
}

export interface PageMetadata {
  limit: number;
  nextCursor: string | null;
}

export interface AuthorizedWatchlistsPage {
  page: PageMetadata;
  watchlists: AuthorizedWatchlistView[];
}

export interface AuthorizedWatchlistDetailPage {
  items: WatchlistItem[];
  page: PageMetadata;
  watchlist: AuthorizedWatchlistView;
}

export function resolveWatchlistRole(args: {
  actorUserId: string;
  watchlist: WatchlistSummary;
}): WatchlistMembershipRole {
  return args.watchlist.ownerUserId === args.actorUserId ? 'owner' : 'editor';
}

export function toAuthorizedWatchlistView(args: {
  actorUserId: string;
  watchlist: WatchlistSummary;
}): AuthorizedWatchlistView {
  return {
    canEdit: args.watchlist.canEdit,
    id: args.watchlist.id,
    kind: args.watchlist.kind,
    name: args.watchlist.name,
    ownerUserId: args.watchlist.ownerUserId,
    role: resolveWatchlistRole(args),
  };
}

export function orderWatchlistItemsForRead(items: WatchlistItem[]): WatchlistItem[] {
  return [...items].sort((left, right) => {
    if (left.addedAt !== right.addedAt) {
      return left.addedAt < right.addedAt ? 1 : -1;
    }

    if (left.id === right.id) {
      return 0;
    }

    return left.id < right.id ? -1 : 1;
  });
}

function toPageMetadata<TEntry>(page: Page<TEntry>): PageMetadata {
  return {
    limit: page.limit,
    nextCursor: page.nextCursor,
  };
}

export async function listAuthorizedWatchlists(args: {
  page: PageRequest;
  repository: WatchlistRepository;
  userId: string;
}): Promise<AuthorizedWatchlistsPage> {
  const watchlists = await listUserWatchlists({
    repository: args.repository,
    userId: args.userId,
  });
  const ordered = [...watchlists].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'personal' ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const page = paginateById(ordered, (watchlist) => watchlist.id, args.page);

  return {
    page: toPageMetadata(page),
    watchlists: page.entries.map((watchlist) =>
      toAuthorizedWatchlistView({ actorUserId: args.userId, watchlist }),
    ),
  };
}

export async function getAuthorizedWatchlistDetail(args: {
  actorUserId: string;
  page: PageRequest;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<AuthorizedWatchlistDetailPage> {
  const detail = await getWatchlistDetail({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  }).catch((error: unknown) => {
    if (error instanceof WatchlistAccessError) {
      throw new WatchlistNotFoundError('Watchlist not found.');
    }

    throw error;
  });
  const page = paginateById(
    orderWatchlistItemsForRead(detail.items.map((item) => ({
      ...item, addedAt: toUtcIsoString(item.addedAt),
    }))),
    (item) => item.id,
    args.page,
  );

  return {
    items: page.entries,
    page: toPageMetadata(page),
    watchlist: toAuthorizedWatchlistView({
      actorUserId: args.actorUserId,
      watchlist: detail.watchlist,
    }),
  };
}
