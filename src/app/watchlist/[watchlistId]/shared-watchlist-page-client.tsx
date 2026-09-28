'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type {
  WatchlistMembershipRole,
  WatchlistSummary,
} from '../../../lib/watchlist';

interface MemberEntry {
  acceptedAt: string | null;
  canRemove: boolean;
  email: string | null;
  id: string;
  isCurrentUser: boolean;
  isOwner: boolean;
  role: WatchlistMembershipRole;
}

interface InviteLinkResponse {
  error?: string;
  inviteUrl?: string;
}

interface RemoveMemberResponse {
  error?: string;
}

interface DeleteWatchlistResponse {
  error?: string;
}

type DeleteWatchlistState = 'confirming' | 'deleting' | 'idle';

export interface SharedWatchlistPageClientProps {
  activeInviteLinkExists: boolean;
  canLeave?: boolean;
  initialMembers: MemberEntry[];
  ownerCanManage: boolean;
  watchlist: WatchlistSummary;
}

function formatAcceptedAt(acceptedAt: string | null): string {
  if (!acceptedAt) {
    return 'Has access through ownership.';
  }

  const parsedDate = new Date(acceptedAt);

  if (Number.isNaN(parsedDate.getTime())) {
    return 'Joined recently.';
  }

  return `Joined ${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsedDate)}.`;
}

export function SharedWatchlistPageClient({
  activeInviteLinkExists,
  canLeave = false,
  initialMembers,
  ownerCanManage,
  watchlist,
}: SharedWatchlistPageClientProps) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [hasActiveInviteLink, setHasActiveInviteLink] = useState(activeInviteLinkExists);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [removingMembershipIds, setRemovingMembershipIds] = useState<
    Record<string, boolean>
  >({});
  const [confirmingMembershipId, setConfirmingMembershipId] = useState<string | null>(
    null,
  );
  const [isConfirmingLeave, setIsConfirmingLeave] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [deleteState, setDeleteState] = useState<DeleteWatchlistState>('idle');

  async function createInviteLink() {
    setErrorMessage(null);
    setStatusMessage(null);
    setIsCreatingInvite(true);

    try {
      const response = await fetch(
        `/api/watchlist/shared/${watchlist.id}/invite`,
        {
          method: 'POST',
        },
      );
      const payload = (await response.json()) as InviteLinkResponse;

      if (!response.ok || !payload.inviteUrl) {
        throw new Error(payload.error ?? 'Could not create an invite link right now.');
      }

      setInviteUrl(payload.inviteUrl);
      setHasActiveInviteLink(true);
      setStatusMessage(
        hasActiveInviteLink
          ? 'Rotated the invite link for this shared watchlist.'
          : 'Created an invite link for this shared watchlist.',
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not create an invite link right now.',
      );
    } finally {
      setIsCreatingInvite(false);
    }
  }

  async function leaveWatchlist() {
    setErrorMessage(null);
    setStatusMessage(null);
    setIsLeaving(true);

    try {
      const response = await fetch(
        `/api/watchlist/shared/${watchlist.id}/membership`,
        {
          method: 'DELETE',
        },
      );
      const payload = (await response.json()) as RemoveMemberResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not leave this watchlist.');
      }

      router.push('/watchlist');
      router.refresh();
    } catch (error) {
      setIsConfirmingLeave(false);
      setIsLeaving(false);
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not leave this watchlist.',
      );
    }
  }

  async function removeMember(member: MemberEntry) {
    setConfirmingMembershipId(null);
    setErrorMessage(null);
    setStatusMessage(null);
    setRemovingMembershipIds((current) => ({
      ...current,
      [member.id]: true,
    }));

    try {
      const response = await fetch(
        `/api/watchlist/shared/${watchlist.id}/members/${member.id}`,
        {
          method: 'DELETE',
        },
      );
      const payload = (await response.json()) as RemoveMemberResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not remove this watchlist member.');
      }

      setMembers((current) => current.filter((entry) => entry.id !== member.id));
      setStatusMessage(
        `Removed ${member.email ?? 'this member'} from ${watchlist.name}.`,
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not remove this watchlist member.',
      );
    } finally {
      setRemovingMembershipIds((current) => ({
        ...current,
        [member.id]: false,
      }));
    }
  }

  async function deleteWatchlist() {
    setErrorMessage(null);
    setStatusMessage(null);
    setDeleteState('deleting');

    try {
      const response = await fetch(`/api/watchlist/shared/${watchlist.id}`, {
        method: 'DELETE',
      });
      const payload = (await response.json()) as DeleteWatchlistResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not delete this watchlist right now.');
      }

      router.push('/watchlist');
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not delete this watchlist right now.',
      );
      setDeleteState('idle');
    }
  }

  return (
    <div className="space-y-8">
      <div aria-live="polite" className="min-h-6 text-sm text-slate-600">
        {statusMessage ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700">
            {statusMessage}
          </p>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
          <p className="font-semibold text-rose-900">Shared watchlist update failed</p>
          <p className="mt-2 leading-6">{errorMessage}</p>
        </div>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
            Access
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            People who can open this watchlist
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            Shared watchlist membership is controlled server-side. Only accepted members
            and the owner can open this page.
          </p>

          <ul className="mt-6 grid gap-4">
            {members.map((member) => {
              const isRemoving = removingMembershipIds[member.id] ?? false;

              return (
                <li
                  key={member.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-950">
                          {member.email ?? 'Unknown member'}
                        </p>
                        {member.isOwner ? (
                          <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white">
                            Owner
                          </span>
                        ) : null}
                        {member.isCurrentUser ? (
                          <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-sky-800">
                            You
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {member.role === 'editor'
                          ? 'Can collaborate on shared-watchlist movie updates as detail flows expand.'
                          : 'Owns this shared watchlist and manages access.'}
                      </p>
                      <p className="mt-2 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                        {formatAcceptedAt(member.acceptedAt)}
                      </p>
                    </div>

                    {ownerCanManage && member.canRemove ? (
                      confirmingMembershipId === member.id || isRemoving ? (
                        <div className="flex flex-col gap-2">
                          <p className="max-w-xs text-sm text-slate-600">
                            Remove {member.email ?? 'this member'}? They will immediately
                            lose access and can rejoin only with a valid invite link.
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                void removeMember(member);
                              }}
                              disabled={isRemoving}
                              className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                            >
                              {isRemoving ? 'Removing…' : 'Confirm removal'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmingMembershipId(null);
                              }}
                              disabled={isRemoving}
                              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:text-slate-400"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmingMembershipId(member.id);
                          }}
                          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-rose-300 hover:text-rose-700"
                        >
                          Remove access
                        </button>
                      )
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </article>

        <aside className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
            Invite link
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            {ownerCanManage ? 'Share access safely' : 'Access details'}
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {ownerCanManage
              ? 'Invite links are secret URLs. Creating a new link rotates the previous one so you can replace a leaked or stale share.'
              : 'Only the shared watchlist owner can create or rotate invite links for new collaborators.'}
          </p>

          {ownerCanManage ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                  <p className="font-semibold text-slate-900">
                  {hasActiveInviteLink
                    ? 'An active invite link already exists.'
                    : 'No invite link has been created yet.'}
                  </p>
                <p className="mt-2 leading-6">
                  Raw invite URLs are only shown once when they are created or rotated.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  void createInviteLink();
                }}
                disabled={isCreatingInvite}
                className="w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isCreatingInvite
                  ? 'Creating…'
                  : hasActiveInviteLink
                    ? 'Rotate invite link'
                    : 'Create invite link'}
              </button>

              {inviteUrl ? (
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">
                    Newly created invite URL
                  </span>
                  <input
                    readOnly
                    value={inviteUrl}
                    className="w-full rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-900"
                  />
                </label>
              ) : null}
            </div>
          ) : (
            <div className="mt-6 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
              <p className="font-semibold text-slate-900">Owner-managed access</p>
              <p className="mt-2 leading-6">
                You currently have access to this shared watchlist, but only the owner can
                inspect or manage other collaborators.
              </p>
              {canLeave ? (
                isConfirmingLeave ? (
                  <div className="mt-4 space-y-3">
                    <p className="leading-6">
                      Leave {watchlist.name}? You will immediately lose access to its
                      movies and it will no longer appear on your calendar. You can rejoin
                      only with a valid invite link.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void leaveWatchlist();
                        }}
                        disabled={isLeaving}
                        className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {isLeaving ? 'Leaving…' : 'Confirm leave'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsConfirmingLeave(false);
                        }}
                        disabled={isLeaving}
                        className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setIsConfirmingLeave(true);
                    }}
                    className="mt-4 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-rose-300 hover:text-rose-700"
                  >
                    Leave watchlist
                  </button>
                )
              ) : null}
            </div>
          )}
        </aside>
      </section>

      {ownerCanManage ? (
        <section className="rounded-3xl border border-rose-200 bg-rose-50 p-6 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-rose-700">
            Danger zone
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-rose-950">
            Permanently delete this watchlist
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-rose-700">
            Deleting {watchlist.name} removes it, every movie saved to it, every
            member&apos;s access, and any invite link immediately. Members lose access
            right away, and a movie that only lived on this list disappears from their
            calendar feed the next time it is requested — a movie also saved to
            another accessible list is unaffected. This cannot be undone.
          </p>

          {deleteState === 'confirming' ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold text-rose-900">
                {`Permanently delete "${watchlist.name}"?`}
              </p>
              <button
                type="button"
                onClick={() => {
                  void deleteWatchlist();
                }}
                className="rounded-xl bg-rose-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-800"
              >
                Confirm delete
              </button>
              <button
                type="button"
                onClick={() => setDeleteState('idle')}
                className="rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:border-rose-400 hover:bg-rose-100"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDeleteState('confirming')}
              disabled={deleteState === 'deleting'}
              className="mt-4 rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:border-rose-500 hover:bg-rose-100 disabled:cursor-not-allowed disabled:border-rose-100 disabled:text-rose-300"
            >
              {deleteState === 'deleting' ? 'Deleting…' : 'Delete watchlist'}
            </button>
          )}
        </section>
      ) : null}
    </div>
  );
}
