import type { ServerSupabaseClient } from '../server';
import type { WatchlistMember, WatchlistMembershipRole } from '../../watchlist';
import { throwSupabaseError, watchlistMembershipSelect } from './shared';

interface WatchlistMembershipRow {
  accepted_at: string | null;
  id: string;
  invited_by_user_id: string | null;
  role: string;
  user_id: string;
  watchlist_id: string;
}

export interface WatchlistMembershipLookupRow {
  role: string;
  watchlist_id: string;
}

/** Postgres `invalid_text_representation` — e.g. a non-uuid id in a uuid filter. */
const INVALID_TEXT_REPRESENTATION = '22P02';

export function assertMembershipRow(data: unknown): WatchlistMembershipRow {
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

export function mapMembershipRow(row: WatchlistMembershipRow): WatchlistMember {
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

export function assertMembershipLookupRows(data: unknown): WatchlistMembershipLookupRow[] {
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

export function createMembershipsAggregate(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}) {
  return {
    async acceptInviteMembership({
      acceptedAt,
      invitedByUserId,
      userId,
      watchlistId,
    }: {
      acceptedAt: string;
      invitedByUserId: string | null;
      userId: string;
      watchlistId: string;
    }): Promise<WatchlistMember> {
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

    async findMembershipByIdForWatchlist(
      watchlistId: string,
      membershipId: string,
    ): Promise<WatchlistMember | null> {
      const { data, error } = await args.adminClient
        .from('watchlist_memberships')
        .select(watchlistMembershipSelect)
        .eq('watchlist_id', watchlistId)
        .eq('id', membershipId)
        .maybeSingle();

      if (error) {
        // A caller-supplied membership id that is not a uuid — the synthetic
        // `owner:<uuid>` id the member list exposes, or anything else crafted —
        // is a lookup miss, not a server fault.
        if (error.code === INVALID_TEXT_REPRESENTATION) {
          return null;
        }

        throwSupabaseError(error);
      }

      return data ? mapMembershipRow(assertMembershipRow(data)) : null;
    },

    async findMembershipForUser(
      watchlistId: string,
      userId: string,
    ): Promise<WatchlistMember | null> {
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

    /**
     * Resolve account emails for member rows. This reads Supabase Auth through
     * the service-role admin client, which is built server-side only
     * (`createServerSupabaseServiceRoleClient`) and never shipped to a browser.
     * Authorization is the caller's job: only
     * `listSharedWatchlistMemberProfiles` reaches this, and only after it has
     * proved the actor owns the list.
     */
    async listMemberEmailsByUserId(
      userIds: string[],
    ): Promise<Record<string, string | null>> {
      const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
      const entries = await Promise.all(
        uniqueUserIds.map(async (userId) => {
          const { data, error } = await args.adminClient.auth.admin.getUserById(userId);

          if (error) {
            // One unreadable account must not take down member management for
            // the whole list; the member still renders without an email.
            console.error('[watchlist] Supabase auth user lookup failed.');

            return [userId, null] as const;
          }

          return [userId, data.user?.email ?? null] as const;
        }),
      );

      return Object.fromEntries(entries);
    },

    async listMembersForWatchlist(watchlistId: string): Promise<WatchlistMember[]> {
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

    async removeMembershipFromWatchlist(
      watchlistId: string,
      membershipId: string,
    ): Promise<boolean> {
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
  };
}
