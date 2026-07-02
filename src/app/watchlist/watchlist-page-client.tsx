'use client';

import Link from 'next/link';
import { useState } from 'react';

import { formatReleaseDate } from '../../lib/format-release-date';
import type { WatchlistItem, WatchlistSummary } from '../../lib/watchlist';

interface DeleteWatchlistResponse {
  error?: string;
}

interface CreateSharedWatchlistResponse {
  error?: string;
  watchlist?: WatchlistSummary;
}

export interface WatchlistPageClientProps {
  initialItems: WatchlistItem[];
  initialWatchlists: WatchlistSummary[];
  overviewErrorMessage: string | null;
  personalItemsErrorMessage: string | null;
  personalWatchlistId: string | null;
}

export function WatchlistPageClient({
  initialItems,
  initialWatchlists,
  overviewErrorMessage,
  personalItemsErrorMessage,
  personalWatchlistId,
}: WatchlistPageClientProps) {
  const [items, setItems] = useState(initialItems);
  const [watchlists, setWatchlists] = useState(initialWatchlists);
  const [createName, setCreateName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isCreatingWatchlist, setIsCreatingWatchlist] = useState(false);
  const [removingItemIds, setRemovingItemIds] = useState<Record<string, boolean>>(
    {},
  );

  const visibleSharedWatchlists = watchlists.filter(
    (watchlist) => watchlist.kind === 'shared',
  );
  const personalWatchlist =
    watchlists.find((watchlist) => watchlist.id === personalWatchlistId)
    ?? watchlists.find((watchlist) => watchlist.kind === 'personal')
    ?? null;

  async function createSharedWatchlist(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setIsCreatingWatchlist(true);

    try {
      const response = await fetch('/api/watchlist/shared', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: createName }),
      });
      const payload = (await response.json()) as CreateSharedWatchlistResponse;

      if (!response.ok || !payload.watchlist) {
        throw new Error(
          payload.error ?? 'Could not create this shared watchlist right now.',
        );
      }

      const nextWatchlist = payload.watchlist;

      setWatchlists((current) => [...current, nextWatchlist]);
      setCreateName('');
      setStatusMessage(`Created shared watchlist ${nextWatchlist.name}.`);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not create this shared watchlist right now.',
      );
    } finally {
      setIsCreatingWatchlist(false);
    }
  }

  async function removeItem(item: WatchlistItem) {
    setErrorMessage(null);
    setStatusMessage(null);
    setRemovingItemIds((current) => ({
      ...current,
      [item.id]: true,
    }));

    try {
      const response = await fetch(
        `/api/watchlist/${item.id}?watchlist_id=${encodeURIComponent(
          personalWatchlist?.id ?? '',
        )}`,
        {
        method: 'DELETE',
        },
      );
      const payload = (await response.json()) as DeleteWatchlistResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not remove this movie right now.');
      }

      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setStatusMessage(`Removed ${item.movie.title} from ${personalWatchlist?.name ?? 'your watchlist'}.`);
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
          <p className="font-semibold text-rose-900">Watchlist update failed</p>
          <p className="mt-2 leading-6">{errorMessage}</p>
        </div>
      ) : null}

      {overviewErrorMessage ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700 shadow-sm">
          <p className="font-semibold text-rose-900">Watchlist overview unavailable</p>
          <p className="mt-2 leading-6">{overviewErrorMessage}</p>
        </div>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.9fr)]">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
                Overview
              </p>
              <h3 className="mt-2 text-2xl font-semibold text-slate-950">
                Watchlists you can access
              </h3>
            </div>
            <p className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600">
              {watchlists.length} total
            </p>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {watchlists.map((watchlist) => {
              const isPersonal = watchlist.kind === 'personal';

              return (
                <article
                  key={watchlist.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${
                        isPersonal
                          ? 'bg-slate-900 text-white'
                          : 'bg-sky-100 text-sky-800'
                      }`}
                    >
                      {isPersonal ? 'Personal' : 'Shared'}
                    </span>
                    {isPersonal ? (
                      <span className="text-xs font-medium text-slate-500">
                        Managed below
                      </span>
                    ) : null}
                  </div>
                  <h4 className="mt-4 text-xl font-semibold text-slate-950">
                    <Link
                      href={`/watchlist/${watchlist.id}`}
                      className="transition hover:text-sky-700"
                    >
                      {watchlist.name}
                    </Link>
                  </h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {isPersonal
                      ? 'Your private watchlist is the default target for item management on this page. Your calendar feed includes movies from every watchlist you can access.'
                      : 'Open the shared watchlist detail page to manage saved movies, invite links, and current access.'}
                  </p>
                  {!isPersonal ? (
                    <Link
                      href={`/watchlist/${watchlist.id}`}
                      className="mt-4 inline-flex rounded-full border border-sky-200 px-3 py-1.5 text-sm font-medium text-sky-800 transition hover:border-sky-300 hover:bg-sky-50"
                    >
                      Open shared watchlist
                    </Link>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
            Create shared watchlist
          </p>
          <h3 className="mt-2 text-2xl font-semibold text-slate-950">
            Start a shared list
          </h3>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Create a collaborative watchlist now. Then open the shared detail page to
            create an invite link and manage who can access it.
          </p>

          <form className="mt-6 space-y-4" onSubmit={(event) => {
            void createSharedWatchlist(event);
          }}>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Watchlist name</span>
              <input
                type="text"
                name="name"
                value={createName}
                onChange={(event) => {
                  setCreateName(event.target.value);
                }}
                placeholder="Friday movie night"
                maxLength={80}
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
              />
            </label>

            <button
              type="submit"
              disabled={isCreatingWatchlist}
              className="w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isCreatingWatchlist ? 'Creating…' : 'Create shared watchlist'}
            </button>
          </form>

          <div className="mt-6 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-semibold text-slate-900">Current shared watchlists</p>
            {visibleSharedWatchlists.length === 0 ? (
              <p className="mt-2 leading-6">
                You do not belong to any shared watchlists yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {visibleSharedWatchlists.map((watchlist) => (
                  <li
                    key={watchlist.id}
                    className="rounded-xl bg-white px-3 py-2"
                  >
                    <Link
                      href={`/watchlist/${watchlist.id}`}
                      className="font-medium text-slate-900 transition hover:text-sky-700"
                    >
                      {watchlist.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </section>

      <section className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
              Personal watchlist
            </p>
            <h3 className="mt-2 text-2xl font-semibold text-slate-950">
              {personalWatchlist?.name ?? 'My watchlist'}
            </h3>
          </div>
          <p className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600">
            {items.length} saved {items.length === 1 ? 'movie' : 'movies'}
          </p>
        </div>

        {personalItemsErrorMessage ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
            <p className="font-semibold text-rose-900">Personal watchlist unavailable</p>
            <p className="mt-2 leading-6">{personalItemsErrorMessage}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-sm text-slate-600">
            <h4 className="text-lg font-semibold text-slate-950">Your watchlist is empty</h4>
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
                        <h4 className="text-2xl font-semibold text-slate-950">
                          {item.movie.title}
                        </h4>
                        <p className="mt-1 text-sm font-medium text-sky-700">
                          {formatReleaseDate(item.movie.releaseDate)}
                        </p>
                      </div>
                      <p className="max-w-2xl text-sm leading-6 text-slate-600">
                        {item.movie.overview
                          ?? 'No overview is available for this movie yet.'}
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
      </section>
    </div>
  );
}
