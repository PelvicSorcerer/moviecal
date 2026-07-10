import type { PostgrestError } from '@supabase/supabase-js';

import type { ServerSupabaseClient } from './server';
import { WatchlistDataError } from '../watchlist';
import type {
  ResolvedWatchlistInvite,
  WatchlistAccessResult,
  WatchlistInviteLink,
  WatchlistKind,
  WatchlistMember,
  WatchlistMembershipRole,
  WatchlistMovieRow,
  WatchlistRepository,
  WatchlistRow,
  WatchlistSummary,
} from '../watchlist';
import type { NormalizedMovieDetail } from '../tmdb/client';

const watchlistSelect = `
  id,
  owner_user_id,
  kind,
  name
`;

const watchlistItemSelect = `
  id,
  added_at,
  movie:movies!watchlist_items_movie_id_fkey (
    id,
    tmdb_id,
    title,
    release_date,
    raw_json,
    updated_at
  )
`;

const trackedMovieSelect = `
  movie:movies!watchlist_items_movie_id_fkey (
    id,
    tmdb_id,
    title,
    release_date,
    raw_json,
    updated_at
  )
`;

const watchlistMembershipSelect = `
  id,
  watchlist_id,
  user_id,
  role,
  invited_by_user_id,
  accepted_at
`;

const watchlistInviteLinkSelect = `
  id,
  watchlist_id,
  created_by_user_id,
  token_hash,
  created_at,
  expires_at,
  revoked_at
`;

interface WatchlistMembershipRow {
  accepted_at: string | null;
  id: string;
  invited_by_user_id: string | null;
  role: string;
  user_id: string;
  watchlist_id: string;
}

interface WatchlistMembershipLookupRow {
  role: string;
  watchlist_id: string;
}

interface WatchlistInviteLinkRow {
  created_at: string;
  created_by_user_id: string;
  expires_at: string | null;
  id: string;
  revoked_at: string | null;
  token_hash: string;
  watchlist_id: string;
}

function assertWatchlistSummary(data: unknown): WatchlistSummary {
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
    canEdit: typeof (data as { canEdit?: unknown }).canEdit === 'boolean'
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

function assertWatchlistRow(data: unknown): WatchlistRow {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'string' ||
    typeof (data as { added_at?: unknown }).added_at !== 'string'
  ) {
    throw new Error('Supabase returned an invalid watchlist row.');
  }

  const movieValue = (data as { movie?: unknown }).movie;

  return {
    id: (data as { id: string }).id,
    added_at: (data as { added_at: string }).added_at,
    movie: movieValue as WatchlistMovieRow | null,
  };
}

function assertWatchlistMovieRow(data: unknown): WatchlistMovieRow {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'number' ||
    typeof (data as { tmdb_id?: unknown }).tmdb_id !== 'number' ||
    typeof (data as { title?: unknown }).title !== 'string' ||
    !(
      typeof (data as { release_date?: unknown }).release_date === 'string' ||
      (data as { release_date?: unknown }).release_date === null
    ) ||
    typeof (data as { updated_at?: unknown }).updated_at !== 'string'
  ) {
    throw new Error('Supabase returned an invalid movie row.');
  }

  return data as WatchlistMovieRow;
}

function assertWatchlistRows(data: unknown): WatchlistRow[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlist response.');
  }

  return data.map(assertWatchlistRow);
}

function assertTrackedMovieRows(data: unknown): WatchlistMovieRow[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid tracked movies response.');
  }

  const uniqueMovies = new Map<number, WatchlistMovieRow>();

  for (const row of data) {
    if (typeof row !== 'object' || row === null) {
      throw new Error('Supabase returned an invalid tracked movie row.');
    }

    const movieValue = (row as { movie?: unknown }).movie;

    if (movieValue === null || movieValue === undefined) {
      continue;
    }

    const movie = assertWatchlistMovieRow(movieValue);
    uniqueMovies.set(movie.tmdb_id, movie);
  }

  return [...uniqueMovies.values()];
}

function assertMembershipRow(data: unknown): WatchlistMembershipRow {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'string' ||
    typeof (data as { watchlist_id?: unknown }).watchlist_id !== 'string' ||
    typeof (data as { user_id?: unknown }).user_id !== 'string' ||
    typeof (data as { role?: unknown }).role !== 'string' ||
    !(
      typeof (data as { invited_by_user_id?: unknown }).invited_by_user_id === 'string' ||
      (data as { invited_by_user_id?: unknown }).invited_by_user_id === null
    ) ||
    !(
      typeof (data as { accepted_at?: unknown }).accepted_at === 'string' ||
      (data as { accepted_at?: unknown }).accepted_at === null
    )
  ) {
    throw new Error('Supabase returned an invalid watchlist membership row.');
  }

  return {
    accepted_at: (data as { accepted_at: string | null }).accepted_at,
    id: (data as { id: string }).id,
    invited_by_user_id: (data as { invited_by_user_id: string | null }).invited_by_user_id,
    role: (data as { role: string }).role,
    user_id: (data as { user_id: string }).user_id,
    watchlist_id: (data as { watchlist_id: string }).watchlist_id,
  };
}

function mapMembershipRow(row: WatchlistMembershipRow): WatchlistMember {
  return {
    acceptedAt: row.accepted_at,
    id: row.id,
    invitedByUserId: row.invited_by_user_id,
    role: row.role as WatchlistMembershipRole,
    userId: row.user_id,
    watchlistId: row.watchlist_id,
  };
}

function assertMembershipRows(data: unknown): WatchlistMember[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlist members response.');
  }

  return data.map((row) => mapMembershipRow(assertMembershipRow(row)));
}

function assertMembershipLookupRows(data: unknown): WatchlistMembershipLookupRow[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlist membership lookup.');
  }

  return data.map((row) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      typeof (row as { role?: unknown }).role !== 'string' ||
      typeof (row as { watchlist_id?: unknown }).watchlist_id !== 'string'
    ) {
      throw new Error('Supabase returned an invalid watchlist membership lookup row.');
    }

    return {
      role: (row as { role: string }).role,
      watchlist_id: (row as { watchlist_id: string }).watchlist_id,
    };
  });
}

function assertInviteLinkRow(data: unknown): WatchlistInviteLinkRow {
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

function mapInviteLinkRow(row: WatchlistInviteLinkRow): WatchlistInviteLink {
  return {
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    expiresAt: row.expires_at,
    id: row.id,
    revokedAt: row.revoked_at,
    watchlistId: row.watchlist_id,
  };
}

function throwSupabaseError(error: PostgrestError | null): never {
  console.error('[watchlist] Supabase request failed', error);
  throw new WatchlistDataError('Supabase request failed.');
}

export function createSupabaseWatchlistRepository(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}): WatchlistRepository {
  return {
    async createWatchlist({ kind, name, ownerUserId }) {
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

    async ensurePersonalWatchlist(userId) {
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

    async acceptInviteMembership({ acceptedAt, invitedByUserId, userId, watchlistId }) {
      const { data: existingData, error: existingError } = await args.adminClient
        .from('watchlist_memberships')
        .select(watchlistMembershipSelect)
        .eq('watchlist_id', watchlistId)
        .eq('user_id', userId)
        .maybeSingle();

      if (existingError) {
        throwSupabaseError(existingError);
      }

      if (existingData) {
        const membership = assertMembershipRow(existingData);

        if (membership.accepted_at) {
          return mapMembershipRow(membership);
        }

        const { data: updatedData, error: updatedError } = await args.adminClient
          .from('watchlist_memberships')
          .update({
            accepted_at: acceptedAt,
            invited_by_user_id: invitedByUserId,
            role: 'editor',
          })
          .eq('id', membership.id)
          .select(watchlistMembershipSelect)
          .single();

        if (updatedError) {
          throwSupabaseError(updatedError);
        }

        return mapMembershipRow(assertMembershipRow(updatedData));
      }

      const { data, error } = await args.adminClient
        .from('watchlist_memberships')
        .insert({
          accepted_at: acceptedAt,
          invited_by_user_id: invitedByUserId,
          role: 'editor',
          user_id: userId,
          watchlist_id: watchlistId,
        })
        .select(watchlistMembershipSelect)
        .single();

      if (error) {
        throwSupabaseError(error);
      }

      return mapMembershipRow(assertMembershipRow(data));
    },

    async createInviteLink({ createdByUserId, expiresAt, tokenHash, watchlistId }) {
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

    async findItemByMovieIdForWatchlist(watchlistId, movieId) {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .select(watchlistItemSelect)
        .eq('watchlist_id', watchlistId)
        .eq('movie_id', movieId)
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return data ? assertWatchlistRow(data) : null;
    },

    async findMembershipForUser(watchlistId, userId) {
      const { data, error } = await args.adminClient
        .from('watchlist_memberships')
        .select(watchlistMembershipSelect)
        .eq('watchlist_id', watchlistId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return data ? mapMembershipRow(assertMembershipRow(data)) : null;
    },

    async findInviteLinkByTokenHash(tokenHash): Promise<ResolvedWatchlistInvite | null> {
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

    async getActiveInviteLinkForWatchlist(watchlistId) {
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

    async insertItemForWatchlist(watchlistId, movieId) {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .insert({
          watchlist_id: watchlistId,
          movie_id: movieId,
        })
        .select(watchlistItemSelect)
        .single();

      if (error) {
        return {
          row: null,
          errorCode: error.code ?? null,
        };
      }

      return {
        row: assertWatchlistRow(data),
        errorCode: null,
      };
    },

    async listItemsForWatchlist(watchlistId) {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .select(watchlistItemSelect)
        .eq('watchlist_id', watchlistId)
        .order('added_at', { ascending: false });

      if (error) {
        throwSupabaseError(error);
      }

      return assertWatchlistRows(data);
    },

    async listMembersForWatchlist(watchlistId) {
      const { data, error } = await args.adminClient
        .from('watchlist_memberships')
        .select(watchlistMembershipSelect)
        .eq('watchlist_id', watchlistId)
        .not('accepted_at', 'is', null)
        .order('accepted_at', { ascending: true });

      if (error) {
        throwSupabaseError(error);
      }

      return assertMembershipRows(data);
    },

    async listTrackedMovies() {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .select(trackedMovieSelect);

      if (error) {
        throwSupabaseError(error);
      }

      return assertTrackedMovieRows(data);
    },

    async listWatchlistsForUser(userId) {
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

    async revokeInviteLinksForWatchlist(watchlistId) {
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

    async removeMembershipFromWatchlist(watchlistId, membershipId) {
      const { data, error } = await args.adminClient
        .from('watchlist_memberships')
        .delete()
        .eq('watchlist_id', watchlistId)
        .eq('id', membershipId)
        .select('id')
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return Boolean(data);
    },

    async getWatchlistAccess(actorUserId, watchlistId): Promise<WatchlistAccessResult> {
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

    async deleteItemByIdForWatchlist(watchlistId, itemId) {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .delete()
        .eq('id', itemId)
        .eq('watchlist_id', watchlistId)
        .select('id')
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return Boolean(data);
    },

    async upsertMovie(detail: NormalizedMovieDetail) {
      const { data, error } = await args.adminClient
        .from('movies')
        .upsert(
          {
            tmdb_id: detail.tmdbId,
            title: detail.title,
            release_date: detail.releaseDate,
            raw_json: detail.rawJson,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: 'tmdb_id',
          },
        )
        .select('id')
        .single();

      if (error || !data) {
        throwSupabaseError(error);
      }

      return { id: data.id };
    },
  };
}
