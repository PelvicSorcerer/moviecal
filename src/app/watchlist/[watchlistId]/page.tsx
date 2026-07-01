import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireAuthenticatedPageSession } from '../../../lib/auth/session';
import {
  getE2EActiveInviteLink,
  getE2EWatchlistAccess,
  listE2EWatchlistMembers,
} from '../../../lib/e2e/shared-watchlists';
import {
  findE2EUserById,
  hasE2EAuthenticatedSession,
  readE2EUser,
  findE2EWatchlist,
  readE2EWatchlistItemsForWatchlist,
} from '../../../lib/e2e/fixtures';
import { SupabaseEnvironmentError } from '../../../lib/supabase/env';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../lib/supabase/watchlist';
import {
  getSharedWatchlistInviteLinkStatus,
  getWatchlistDetail,
  listSharedWatchlistMembers,
  WatchlistAccessError,
  WatchlistDataError,
  WatchlistNotFoundError,
  type WatchlistMember,
  type WatchlistSummary,
} from '../../../lib/watchlist';
import { WatchlistDetailClient } from '../watchlist-detail-client';
import { SharedWatchlistPageClient } from './shared-watchlist-page-client';

export const metadata: Metadata = {
  title: 'Watchlist detail | moviecal',
  description:
    'Review watchlist movies and, for shared watchlists, inspect access and invite management.',
};

interface MemberEntry {
  acceptedAt: string | null;
  canRemove: boolean;
  email: string | null;
  id: string;
  isCurrentUser: boolean;
  isOwner: boolean;
  role: 'owner' | 'editor';
}

async function resolveUserEmailMap(userIds: string[]): Promise<Record<string, string | null>> {
  const adminClient = createServerSupabaseServiceRoleClient();
  const userEmailEntries = await Promise.all(
    [...new Set(userIds)].map(async (userId) => {
      const userResponse = await adminClient.auth.admin.getUserById(userId);

      return [userId, userResponse.data.user?.email ?? null] as const;
    }),
  );

  return Object.fromEntries(userEmailEntries);
}

function mapMemberEntries(args: {
  actorUserId: string;
  emailsByUserId: Record<string, string | null>;
  members: WatchlistMember[];
  watchlist: WatchlistSummary;
}): MemberEntry[] {
  return args.members.map((member) => ({
    acceptedAt: member.acceptedAt,
    canRemove: member.role !== 'owner',
    email: args.emailsByUserId[member.userId] ?? null,
    id: member.id,
    isCurrentUser: member.userId === args.actorUserId,
    isOwner: member.role === 'owner',
    role: member.role,
  }));
}

export default async function WatchlistDetailPage({
  params,
}: {
  params: Promise<{ watchlistId: string }>;
}) {
  const { watchlistId } = await params;
  const { accessToken, user } = await requireAuthenticatedPageSession(
    `/watchlist/${watchlistId}`,
  );

  let detail: Awaited<ReturnType<typeof getWatchlistDetail>> | null = null;
  let ownerCanManage = false;
  let activeInviteLinkExists = false;
  let memberEntries: MemberEntry[] = [];

  try {
    const cookieStore = await cookies();

    if (hasE2EAuthenticatedSession(cookieStore) && user.id === readE2EUser(cookieStore).id) {
      const watchlist = findE2EWatchlist(cookieStore, watchlistId);

      if (!watchlist) {
        notFound();
      }

      detail = {
        watchlist,
        items: readE2EWatchlistItemsForWatchlist(cookieStore, watchlistId),
      };

      if (watchlist.kind === 'shared') {
        const access = getE2EWatchlistAccess(cookieStore, user.id, watchlistId);

        if (!access) {
          notFound();
        }

        ownerCanManage = watchlist.ownerUserId === user.id;
        activeInviteLinkExists = ownerCanManage
          && getE2EActiveInviteLink(cookieStore, watchlistId) !== null;

        if (ownerCanManage) {
          const members = [
            {
              acceptedAt: null,
              id: `owner:${watchlist.ownerUserId}`,
              invitedByUserId: null,
              role: 'owner' as const,
              userId: watchlist.ownerUserId,
              watchlistId: watchlist.id,
            },
            ...listE2EWatchlistMembers(cookieStore, watchlistId),
          ];
          const emailsByUserId = Object.fromEntries(
            members.map((member) => [
              member.userId,
              findE2EUserById(member.userId)?.email ?? null,
            ]),
          );

          memberEntries = mapMemberEntries({
            actorUserId: user.id,
            emailsByUserId,
            members,
            watchlist,
          });
        }
      }
    } else {
      const repository = createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      });

      detail = await getWatchlistDetail({
        actorUserId: user.id,
        repository,
        watchlistId,
      });

      if (detail.watchlist.kind === 'shared') {
        ownerCanManage = detail.watchlist.ownerUserId === user.id;

        if (ownerCanManage) {
          const members = await listSharedWatchlistMembers({
            actorUserId: user.id,
            repository,
            watchlistId,
          });
          const emailsByUserId = await resolveUserEmailMap(
            members.map((member) => member.userId),
          );

          memberEntries = mapMemberEntries({
            actorUserId: user.id,
            emailsByUserId,
            members,
            watchlist: detail.watchlist,
          });
          activeInviteLinkExists = (
            await getSharedWatchlistInviteLinkStatus({
              actorUserId: user.id,
              repository,
              watchlistId,
            })
          ) !== null;
        }
      }
    }
  } catch (error) {
    if (
      error instanceof WatchlistAccessError ||
      error instanceof WatchlistNotFoundError
    ) {
      notFound();
    }

    if (error instanceof SupabaseEnvironmentError) {
      return (
        <section className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-sm text-rose-700 shadow-sm">
          <p className="font-semibold text-rose-900">Watchlist detail unavailable</p>
          <p className="mt-2 leading-6">
            Watchlist detail is unavailable until Supabase is configured for this environment.
          </p>
        </section>
      );
    }

    if (error instanceof WatchlistDataError) {
      return (
        <section className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-sm text-rose-700 shadow-sm">
          <p className="font-semibold text-rose-900">Watchlist detail unavailable</p>
          <p className="mt-2 leading-6">{error.message}</p>
        </section>
      );
    }

    throw error;
  }

  if (!detail) {
    notFound();
  }

  const isSharedWatchlist = detail.watchlist.kind === 'shared';

  return (
    <section className="space-y-8">
      <div className="rounded-3xl bg-slate-950 px-8 py-10 text-white shadow-xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-200">
          {isSharedWatchlist ? 'Shared watchlist detail' : 'Watchlist detail'}
        </p>
        <h1 className="mt-3 text-4xl font-semibold leading-tight">{detail.watchlist.name}</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-200">
          {isSharedWatchlist
            ? 'Review the movies saved here and, when you own the watchlist, manage invite links and collaborator access from the same route.'
            : 'Review and manage the movies saved to this authorized watchlist without exposing any other list metadata.'}
        </p>
        <div className="mt-6">
          <Link
            href="/watchlist"
            className="inline-flex rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500 hover:text-white"
          >
            Back to watchlists
          </Link>
        </div>
      </div>

      <WatchlistDetailClient
        initialItems={detail.items}
        watchlist={detail.watchlist}
      />

      {isSharedWatchlist ? (
        <SharedWatchlistPageClient
          activeInviteLinkExists={activeInviteLinkExists}
          initialMembers={memberEntries}
          ownerCanManage={ownerCanManage}
          watchlist={detail.watchlist}
        />
      ) : null}
    </section>
  );
}
