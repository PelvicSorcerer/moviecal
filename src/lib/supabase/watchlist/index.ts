import type { ServerSupabaseClient } from '../server';
import type { WatchlistRepository } from '../../watchlist';
import { createInvitesAggregate } from './invites';
import { createItemsAggregate } from './items';
import { createMembershipsAggregate } from './memberships';
import { createWatchlistsAggregate } from './watchlists';

export function createSupabaseWatchlistRepository(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}): WatchlistRepository {
  return {
    ...createWatchlistsAggregate(args),
    ...createItemsAggregate(args),
    ...createMembershipsAggregate(args),
    ...createInvitesAggregate(args),
  };
}
