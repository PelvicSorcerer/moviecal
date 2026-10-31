'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MoviePoster } from '../movie-poster';

import { formatReleaseDate } from '../../lib/format-release-date';
import type { WatchlistItem, WatchlistSummary } from '../../lib/watchlist';

interface DeleteWatchlistResponse {
  error?: string;
}

interface RenameWatchlistResponse {
  error?: string;
  watchlist?: WatchlistSummary;
}

export function WatchlistDetailClient({
  initialItems,
  watchlist,
}: {
  initialItems: WatchlistItem[];
  watchlist: WatchlistSummary;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [name, setName] = useState(watchlist.name);
  const [renameInput, setRenameInput] = useState(watchlist.name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [removingItemIds, setRemovingItemIds] = useState<Record<string, boolean>>(
    {},
  );

  const canRename = watchlist.kind === 'shared' && watchlist.canEdit;

  async function removeItem(item: WatchlistItem) {
    setErrorMessage(null);
    setStatusMessage(null);
    setRemovingItemIds((current) => ({
      ...current,
      [item.id]: true,
    }));

    try {
      const response = await fetch(
        `/api/watchlist/${item.id}?watchlist_id=${encodeURIComponent(watchlist.id)}`,
        {
          method: 'DELETE',
        },
      );
      const payload = (await response.json()) as DeleteWatchlistResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not remove this movie right now.');
      }

      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setStatusMessage(`Removed ${item.movie.title} from ${name}.`);
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

  async function renameWatchlist(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setIsRenaming(true);

    try {
      const response = await fetch(`/api/watchlist/shared/${watchlist.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: renameInput }),
      });
      const payload = (await response.json()) as RenameWatchlistResponse;

      if (!response.ok || !payload.watchlist) {
        throw new Error(payload.error ?? 'Could not rename this watchlist right now.');
      }

      setName(payload.watchlist.name);
      setRenameInput(payload.watchlist.name);
      setIsEditingName(false);
      setStatusMessage(`Renamed watchlist to ${payload.watchlist.name}.`);
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not rename this watchlist right now.',
      );
    } finally {
      setIsRenaming(false);
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
          <p className="font-semibold text-rose-900">Watchlist update failed</p>
          <p className="mt-2 leading-6">{errorMessage}</p>
        </div>
      ) : null}

      <section className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
              {watchlist.kind === 'personal' ? 'Personal watchlist' : 'Shared watchlist'}
            </p>
            <h3 className="mt-2 text-2xl font-semibold text-slate-950">
              {name}
            </h3>
          </div>
          <p className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600">
            {items.length} saved {items.length === 1 ? 'movie' : 'movies'}
          </p>
        </div>

        {canRename ? (
          <div>
            {isEditingName ? (
              <form
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  void renameWatchlist(event);
                }}
              >
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-slate-700">Watchlist name</span>
                  <input
                    type="text"
                    value={renameInput}
                    onChange={(event) => {
                      setRenameInput(event.target.value);
                    }}
                    maxLength={80}
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-200 sm:w-72"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={isRenaming}
                    className="rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                  >
                    {isRenaming ? 'Saving…' : 'Save name'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenameInput(name);
                      setIsEditingName(false);
                    }}
                    disabled={isRenaming}
                    className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setIsEditingName(true);
                }}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-sky-300 hover:text-sky-700"
              >
                Rename
              </button>
            )}
          </div>
        ) : null}

        {!watchlist.canEdit ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
            <p className="font-semibold text-slate-900">Read-only access</p>
            <p className="mt-2 leading-6">
              You can review the movies saved to {name}, but your membership does not
              allow edits for this watchlist.
            </p>
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-sm text-slate-600">
            <h4 className="text-lg font-semibold text-slate-950">This watchlist is empty</h4>
            <p className="mt-2 max-w-2xl leading-6">
              {watchlist.canEdit
                ? `Save movies from search and target ${name} to manage them here.`
                : 'Search for movies to save to a watchlist you can edit.'}
            </p>
            <Link
              href="/search"
              className="mt-4 inline-flex rounded-full bg-sky-700 px-4 py-2 font-medium text-white transition hover:bg-sky-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
            >
              Search movies
            </Link>
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
                    <div className="min-w-0 space-y-3">
                      <div className="flex items-start gap-3">
                        <MoviePoster posterPath={item.movie.posterPath} title={item.movie.title} />
                        <div className="min-w-0 break-words">
                        <h4 className="text-2xl font-semibold text-slate-950">
                          {item.movie.title}
                        </h4>
                        <p className="mt-1 text-sm font-medium text-sky-700">
                          {formatReleaseDate(item.movie.releaseDate)}
                        </p>
                        </div>
                      </div>
                      <p className="max-w-2xl text-sm leading-6 text-slate-600">
                        {item.movie.overview
                          ?? 'No overview is available for this movie yet.'}
                      </p>
                    </div>

                    {watchlist.canEdit ? (
                    <div className="shrink-0 sm:w-40">
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
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
