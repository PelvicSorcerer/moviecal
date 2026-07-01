'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface AcceptInviteResponse {
  error?: string;
  joined?: boolean;
  watchlist?: {
    id: string;
    name: string;
  };
}

export interface WatchlistInvitePageClientProps {
  canAccept: boolean;
  token: string;
  watchlistId: string | null;
  watchlistName: string | null;
}

export function WatchlistInvitePageClient({
  canAccept,
  token,
  watchlistId,
  watchlistName,
}: WatchlistInvitePageClientProps) {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);

  async function acceptInvite() {
    setErrorMessage(null);
    setStatusMessage(null);
    setIsAccepting(true);

    try {
      const response = await fetch('/api/watchlist/invite/accept', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json()) as AcceptInviteResponse;

      if (!response.ok || !payload.watchlist) {
        throw new Error(payload.error ?? 'Could not join this shared watchlist.');
      }

      setStatusMessage(
        payload.joined
          ? `Joined ${payload.watchlist.name}.`
          : `You already have access to ${payload.watchlist.name}.`,
      );

      router.push(`/watchlist/${payload.watchlist.id}`);
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not join this shared watchlist.',
      );
    } finally {
      setIsAccepting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div aria-live="polite" className="min-h-6 text-sm text-slate-600">
        {statusMessage ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700">
            {statusMessage}
          </p>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
          <p className="font-semibold text-rose-900">Invite acceptance failed</p>
          <p className="mt-2 leading-6">{errorMessage}</p>
        </div>
      ) : null}

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
          Shared watchlist invite
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-950">
          {watchlistName ?? 'Invite unavailable'}
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          {canAccept
            ? 'Accepting this invite gives your signed-in account access to the shared watchlist inside the app.'
            : 'This invite cannot be used. It may have expired, been rotated, or never existed.'}
        </p>

        {canAccept && watchlistId ? (
          <button
            type="button"
            onClick={() => {
              void acceptInvite();
            }}
            disabled={isAccepting}
            className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {isAccepting ? 'Joining…' : `Join ${watchlistName ?? 'shared watchlist'}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
