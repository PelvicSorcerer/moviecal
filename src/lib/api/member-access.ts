import {
  WatchlistAccessError,
  WatchlistNotFoundError,
  type WatchlistRepository,
} from '../watchlist';

/**
 * Runs a bearer member-management operation without revealing that a list
 * exists to someone who cannot see it. A denial for an outsider or pending
 * invitee reads as the same 404 an unknown id gets; an accepted member who
 * merely lacks the role (an editor on an owner-only action) keeps the 403.
 */
export async function withHiddenUnauthorizedAccess<T>(args: {
  actorUserId: string;
  operation: () => Promise<T>;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<T> {
  try {
    return await args.operation();
  } catch (error) {
    if (!(error instanceof WatchlistAccessError)) {
      throw error;
    }

    const access = await args.repository.getWatchlistAccess(
      args.actorUserId,
      args.watchlistId,
    );

    if (access.status !== 'authorized') {
      throw new WatchlistNotFoundError('Watchlist not found.');
    }

    throw error;
  }
}
