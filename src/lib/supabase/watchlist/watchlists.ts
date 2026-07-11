import type { ServerSupabaseClient } from '../server';
import type {
  WatchlistAccessResult,
  WatchlistKind,
  WatchlistSummary,
} from '../../watchlist';
import { throwSupabaseError, watchlistSelect, watchlistMembershipSelect } from './shared';
import {
  assertMembershipLookupRows,
  assertMembershipRow,
  mapMembershipRow,
} from './memberships';

export function assertWatchlistSummary(data: unknown): WatchlistSummary {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'string' ||
    typeof (data as { owner_user_id?: unknown }).owner_user_id !== 'string' ||
    ((data as { kind?: unknown }).kind !== 'personal' &&
      (data as { kind?: unknown }).kind !== 'shared') ||
    typeof (data as { name?: unknown }).name !== 'string'
  ) {
    throw new Error('Supabase returned an invalid watchlist row.');
  }

  return {
    canEdit:
      typeof (data as { canEdit?: unknown }).canEdit === 'boolean'
        ? (data as { canEdit: boolean }).canEdit
        : true,
    id: (data as { id: string }).id,
    kind: (data as { kind: WatchlistKind }).kind,
    name: (data as { name: string }).name,
    ownerUserId: (data as { owner_user_id: string }).owner_user_id,
  };
}

function assertWatchlistSummaries(data: unknown): WatchlistSummary[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlists response.');
  }

  return data.map(assertWatchlistSummary);
}

export function createWatchlistsAggregate(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}) {
  return {
    async createWatchlist({
      kind,
      name,
      ownerUserId,
    }: {
      kind: WatchlistKind;
      name: string;
      ownerUserId: string;
    }): Promise<WatchlistSummary> {
      const { data, error } = await args.userClient
        .from('watchlists')
        .insert({
          kind,
          name,
          owner_user_id: ownerUserId,
        })
        .select(watchlistSelect)
        .single();

      if (error) {
        throwSupabaseError(error);
      }

      return assertWatchlistSummary(data);
    },

    async ensurePersonalWatchlist(userId: string): Promise<WatchlistSummary> {
      // RPC requires EXECUTE on ensure_personal_watchlist_for_user. When
      // userClient carries an authenticated JWT this is granted by the
      // original schema migration. Callers that pass adminClient (service_role)
      // as userClient — e.g. cron and calendar-feed routes — still rely on the
      // service_role EXECUTE grant from migration
      // 20260709000001_issue_138_service_role_function_grants.sql.
      const { data: watchlistId, error: watchlistIdError } = await args.userClient.rpc(
        'ensure_personal_watchlist_for_user',
        {
          target_user_id: userId,
        },
      );

      if (watchlistIdError || typeof watchlistId !== 'string') {
        throwSupabaseError(watchlistIdError);
      }

      const { data, error } = await args.adminClient
        .from('watchlists')
        .select(watchlistSelect)
        .eq('id', watchlistId)
        .single();

      if (error) {
        throwSupabaseError(error);
      }

      return assertWatchlistSummary(data);
    },

    async listWatchlistsForUser(userId: string): Promise<WatchlistSummary[]> {
      const { data: ownedData, error: ownedError } = await args.userClient
        .from('watchlists')
        .select(watchlistSelect)
        .eq('owner_user_id', userId)
        .order('created_at', { ascending: true });

      if (ownedError) {
        throwSupabaseError(ownedError);
      }

      const { data: membershipData, error: membershipError } = await args.userClient
        .from('watchlist_memberships')
        .select('watchlist_id, role')
        .eq('user_id', userId)
        .not('accepted_at', 'is', null);

      if (membershipError) {
        throwSupabaseError(membershipError);
      }

      const watchlists = new Map<string, WatchlistSummary>();

      for (const watchlist of assertWatchlistSummaries(ownedData)) {
        watchlists.set(watchlist.id, {
          ...watchlist,
          canEdit: true,
        });
      }

      const membershipRows = assertMembershipLookupRows(membershipData);
      const memberWatchlistIds = membershipRows
        .map((membership) => membership.watchlist_id)
        .filter((watchlistId) => !watchlists.has(watchlistId));

      if (memberWatchlistIds.length === 0) {
        return [...watchlists.values()];
      }

      const { data: memberWatchlistsData, error: memberWatchlistsError } =
        await args.userClient
          .from('watchlists')
          .select(watchlistSelect)
          .in('id', memberWatchlistIds)
          .order('created_at', { ascending: true });

      if (memberWatchlistsError) {
        throwSupabaseError(memberWatchlistsError);
      }

      const memberRoleByWatchlistId = new Map(
        membershipRows.map((membership) => [membership.watchlist_id, membership.role]),
      );

      for (const watchlist of assertWatchlistSummaries(memberWatchlistsData)) {
        const role = memberRoleByWatchlistId.get(watchlist.id);

        watchlists.set(watchlist.id, {
          ...watchlist,
          canEdit: role === 'owner' || role === 'editor',
        });
      }

      return [...watchlists.values()];
    },

    async getWatchlistAccess(
      actorUserId: string,
      watchlistId: string,
    ): Promise<WatchlistAccessResult> {
      const { data: watchlistData, error: watchlistError } = await args.adminClient
        .from('watchlists')
        .select(watchlistSelect)
        .eq('id', watchlistId)
        .maybeSingle();

      if (watchlistError) {
        throwSupabaseError(watchlistError);
      }

      if (!watchlistData) {
        return { status: 'not_found' };
      }

      const watchlist = assertWatchlistSummary(watchlistData);

      if (watchlist.ownerUserId === actorUserId) {
        return {
          status: 'authorized',
          watchlist: {
            ...watchlist,
            canEdit: true,
          },
          canEdit: true,
        };
      }

      const { data: membershipData, error: membershipError } = await args.adminClient
        .from('watchlist_memberships')
        .select(watchlistMembershipSelect)
        .eq('watchlist_id', watchlistId)
        .eq('user_id', actorUserId)
        .maybeSingle();

      if (membershipError) {
        throwSupabaseError(membershipError);
      }

      if (!membershipData) {
        return { status: 'forbidden' };
      }

      const membership = assertMembershipRow(membershipData);

      if (!membership.accepted_at) {
        return { status: 'forbidden' };
      }

      return {
        status: 'authorized',
        watchlist: {
          ...watchlist,
          canEdit: membership.role === 'owner' || membership.role === 'editor',
        },
        canEdit: membership.role === 'owner' || membership.role === 'editor',
      };
    },
  };
}
