import type { ServerSupabaseClient } from '../server';
import type { ResolvedWatchlistInvite, WatchlistInviteLink } from '../../watchlist';
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
    async createInviteLink({
      createdByUserId,
      expiresAt,
      tokenHash,
      watchlistId,
    }: {
      createdByUserId: string;
      expiresAt: string | null;
      tokenHash: string;
      watchlistId: string;
    }): Promise<WatchlistInviteLink> {
      const { data, error } = await args.adminClient
        .from('watchlist_invite_links')
        .insert({
          created_by_user_id: createdByUserId,
          expires_at: expiresAt,
          token_hash: tokenHash,
          watchlist_id: watchlistId,
        })
        .select(watchlistInviteLinkSelect)
        .single();

      if (error) {
        throwSupabaseError(error);
      }

      return mapInviteLinkRow(assertInviteLinkRow(data));
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
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return data ? mapInviteLinkRow(assertInviteLinkRow(data)) : null;
    },

    async revokeInviteLinksForWatchlist(watchlistId: string): Promise<void> {
      const { error } = await args.adminClient
        .from('watchlist_invite_links')
        .update({
          revoked_at: new Date().toISOString(),
        })
        .eq('watchlist_id', watchlistId)
        .is('revoked_at', null);

      if (error) {
        throwSupabaseError(error);
      }
    },
  };
}
