import type { ServerSupabaseClient } from '../server';
import { WatchlistDataError, type ResolvedWatchlistInvite, type WatchlistInviteLink } from '../../watchlist';
import {
  throwSupabaseError,
  watchlistInviteLinkSelect,
  watchlistSelect,
} from './shared';
import { assertWatchlistSummary } from './watchlists';

interface WatchlistInviteLinkRow {
  created_at: string;
  created_by_user_id: string;
  expires_at: string | null;
  id: string;
  revoked_at: string | null;
  token_hash: string;
  watchlist_id: string;
}

export function assertInviteLinkRow(data: unknown): WatchlistInviteLinkRow {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'string' ||
    typeof (data as { watchlist_id?: unknown }).watchlist_id !== 'string' ||
    typeof (data as { created_by_user_id?: unknown }).created_by_user_id !== 'string' ||
    typeof (data as { token_hash?: unknown }).token_hash !== 'string' ||
    typeof (data as { created_at?: unknown }).created_at !== 'string' ||
    !(
      typeof (data as { expires_at?: unknown }).expires_at === 'string' ||
      (data as { expires_at?: unknown }).expires_at === null
    ) ||
    !(
      typeof (data as { revoked_at?: unknown }).revoked_at === 'string' ||
      (data as { revoked_at?: unknown }).revoked_at === null
    )
  ) {
    throw new Error('Supabase returned an invalid watchlist invite link row.');
  }

  return data as WatchlistInviteLinkRow;
}

export function mapInviteLinkRow(row: WatchlistInviteLinkRow): WatchlistInviteLink {
  return {
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    expiresAt: row.expires_at,
    id: row.id,
    revokedAt: row.revoked_at,
    watchlistId: row.watchlist_id,
  };
}

export function createInvitesAggregate(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}) {
  return {
    async rotateInviteLink({
      tokenHash,
      watchlistId,
    }: {
      tokenHash: string | null;
      watchlistId: string;
    }): Promise<WatchlistInviteLink | null> {
      const { data, error } = await args.userClient.rpc('rotate_watchlist_invite_link', {
        target_watchlist_id: watchlistId,
        new_token_hash: tokenHash,
      });

      if (error) {
        // Do not log RPC errors: they can contain the hash passed to the call.
        throw new WatchlistDataError('Supabase request failed.');
      }

      return data ? mapInviteLinkRow(assertInviteLinkRow(data)) : null;
    },

    async findInviteLinkByTokenHash(
      tokenHash: string,
    ): Promise<ResolvedWatchlistInvite | null> {
      const { data: inviteData, error: inviteError } = await args.adminClient
        .from('watchlist_invite_links')
        .select(watchlistInviteLinkSelect)
        .eq('token_hash', tokenHash)
        .maybeSingle();

      if (inviteError) {
        throwSupabaseError(inviteError);
      }

      if (!inviteData) {
        return null;
      }

      const inviteLink = mapInviteLinkRow(assertInviteLinkRow(inviteData));
      const { data: watchlistData, error: watchlistError } = await args.adminClient
        .from('watchlists')
        .select(watchlistSelect)
        .eq('id', inviteLink.watchlistId)
        .maybeSingle();

      if (watchlistError) {
        throwSupabaseError(watchlistError);
      }

      if (!watchlistData) {
        return null;
      }

      return {
        inviteLink,
        watchlist: assertWatchlistSummary(watchlistData),
      };
    },

    async getActiveInviteLinkForWatchlist(
      watchlistId: string,
    ): Promise<WatchlistInviteLink | null> {
      const { data, error } = await args.adminClient
        .from('watchlist_invite_links')
        .select(watchlistInviteLinkSelect)
        .eq('watchlist_id', watchlistId)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return data ? mapInviteLinkRow(assertInviteLinkRow(data)) : null;
    },

  };
}
