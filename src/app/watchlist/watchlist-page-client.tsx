'use client';

import { useState } from 'react';

import type { WatchlistItem } from '../../lib/watchlist';
import { formatReleaseDate } from '../../lib/format-release-date';

interface DeleteWatchlistResponse {
  error?: string;
}

export interface WatchlistPageClientProps {
  initialItems: WatchlistItem[];
}

export function WatchlistPageClient({
  initialItems,
}: WatchlistPageClientProps) {
  const [items, setItems] = useState(initialItems);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [removingItemIds, setRemovingItemIds] = useState<Record<string, boolean>>(
    {},
  );

  async function removeItem(item: WatchlistItem) {
    setErrorMessage(null);
    setStatusMessage(null);
    setRemovingItemIds((current) => ({
      ...current,
      [item.id]: true,
    }));

    try {
      const response = await fetch(`/api/watchlist/${item.id}`, {
        method: 'DELETE',
      });
      const payload = (await response.json()) as DeleteWatchlistResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not remove this movie right now.');
      }

      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setStatusMessage(`Removed ${item.movie.title} from your watchlist.`);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not remove this movie right now.',
      );
    } finally {
      setRemovingItemIds((current) => ({
        ...current,
        [item.id]: false,
      }));
    }
  }

  return (
    <div className="space-y-5">
      <div aria-live="polite" className="min-h-6 text-sm text-slate-600">
        {statusMessage ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700">
            {statusMessage}
          </p>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
          <p className="font-semibold text-rose-900">Watchlist update failed</p>
          <p className="mt-2 leading-6">{errorMessage}</p>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-sm text-slate-600">
          <h3 className="text-lg font-semibold text-slate-950">Your watchlist is empty</h3>
          <p className="mt-2 max-w-2xl leading-6">
            Save movies from the search page to track upcoming release dates here.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4">
          {items.map((item) => {
            const isRemoving = removingItemIds[item.id] ?? false;

            return (
              <li
                key={item.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-2xl font-semibold text-slate-950">
                        {item.movie.title}
                      </h3>
                      <p className="mt-1 text-sm font-medium text-sky-700">
                        {formatReleaseDate(item.movie.releaseDate)}
                      </p>
                    </div>
                    <p className="max-w-2xl text-sm leading-6 text-slate-600">
                      {item.movie.overview ??
                        'No overview is available for this movie yet.'}
                    </p>
                  </div>

                  <div className="sm:w-40">
                    <button
                      type="button"
                      onClick={() => {
                        void removeItem(item);
                      }}
                      disabled={isRemoving}
                      className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-rose-300 hover:text-rose-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                    >
                      {isRemoving ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
