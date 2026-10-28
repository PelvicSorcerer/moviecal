'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  startTransition,
  useEffect,
  useState,
} from 'react';

import { formatReleaseDate } from '../../lib/format-release-date';
import type { WatchlistSummary } from '../../lib/watchlist';
import type { NormalizedMovieSummary } from '../../lib/tmdb/client';
import { MoviePoster } from '../movie-poster';

type SearchStatus = 'idle' | 'loading' | 'success' | 'error';
export type WatchlistStatus = 'idle' | 'saving' | 'saved' | 'error';

interface WatchlistMutationState {
  status: WatchlistStatus;
  watchlistName?: string;
}

interface SearchResponse {
  results?: NormalizedMovieSummary[];
  error?: string;
}

interface WatchlistResponse {
  error?: string;
  watchlist?: WatchlistSummary;
}

export interface SearchPageClientProps {
  availableWatchlists: WatchlistSummary[];
  initialQuery: string;
  isAuthenticated: boolean;
  watchlistLoadFailed?: boolean;
}

export function getSearchHref(pathname: string, query: string): string {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return pathname;
  }

  return `${pathname}?q=${encodeURIComponent(trimmedQuery)}`;
}

export function getWatchlistSignInHref(
  pathname: string,
  submittedQuery: string,
): string {
  return `/sign-in?next=${encodeURIComponent(getSearchHref(pathname, submittedQuery))}`;
}

export function getResultCountLabel(resultCount: number): string {
  return resultCount === 1 ? '1 match' : `${resultCount} matches`;
}

export function shouldSyncSubmittedQuery(
  initialQuery: string,
  submittedQuery: string,
): boolean {
  return initialQuery !== submittedQuery;
}

export function getWatchlistStatusMessage(
  state: WatchlistMutationState | undefined,
  targetWatchlistName: string | null,
): string {
  if (state?.status === 'error') {
    return 'Could not add this movie right now.';
  }

  if (state?.status === 'saved') {
    const watchlistName = state.watchlistName ?? targetWatchlistName;

    return watchlistName
      ? `Saved to ${watchlistName}.`
      : 'The authenticated add flow succeeded for this movie.';
  }

  return targetWatchlistName
    ? `Add this result to ${targetWatchlistName}.`
    : 'Add this result to your private watchlist.';
}

export function SearchPageClient({
  availableWatchlists,
  initialQuery,
  isAuthenticated,
  watchlistLoadFailed = false,
}: SearchPageClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [searchNonce, setSearchNonce] = useState(0);
  const [status, setStatus] = useState<SearchStatus>(initialQuery ? 'loading' : 'idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<NormalizedMovieSummary[]>([]);
  const editableWatchlists = availableWatchlists.filter((watchlist) => watchlist.canEdit);
  const readOnlyWatchlists = availableWatchlists.filter((watchlist) => !watchlist.canEdit);
  const [watchlistStatusByMovie, setWatchlistStatusByMovie] = useState<
    Record<number, WatchlistMutationState>
  >({});
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<string>(() => {
    const personalWatchlist = editableWatchlists.find((watchlist) => watchlist.kind === 'personal');

    return personalWatchlist?.id ?? editableWatchlists[0]?.id ?? '';
  });

  useEffect(() => {
    const personalWatchlist = editableWatchlists.find((watchlist) => watchlist.kind === 'personal');
    const nextSelectedWatchlistId = personalWatchlist?.id ?? editableWatchlists[0]?.id ?? '';

    setSelectedWatchlistId((current) => (
      editableWatchlists.some((watchlist) => watchlist.id === current)
        ? current
        : nextSelectedWatchlistId
    ));
  }, [editableWatchlists]);

  useEffect(() => {
    setQuery(initialQuery);

    if (!shouldSyncSubmittedQuery(initialQuery, submittedQuery)) {
      return;
    }

    setSubmittedQuery(initialQuery);
    setStatus(initialQuery ? 'loading' : 'idle');
    setErrorMessage(null);
  }, [initialQuery, submittedQuery]);

  useEffect(() => {
    let isCancelled = false;

    async function runSearch(nextQuery: string) {
      if (!nextQuery) {
        if (!isCancelled) {
          setResults([]);
          setErrorMessage(null);
          setStatus('idle');
        }

        return;
      }

      if (!isCancelled) {
        setStatus('loading');
        setErrorMessage(null);
      }

      try {
        const response = await fetch(
          `/api/movies/search?q=${encodeURIComponent(nextQuery)}`,
          {
            method: 'GET',
            cache: 'no-store',
          },
        );

        const payload = (await response.json()) as SearchResponse;

        if (!response.ok) {
          throw new Error(payload.error ?? 'Movie search is unavailable right now.');
        }

        if (!isCancelled) {
          setResults(Array.isArray(payload.results) ? payload.results : []);
          setStatus('success');
        }
      } catch (error) {
        if (!isCancelled) {
          setResults([]);
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Movie search is unavailable right now.',
          );
          setStatus('error');
        }
      }
    }

    void runSearch(submittedQuery);

    return () => {
      isCancelled = true;
    };
  }, [searchNonce, submittedQuery]);

  async function addToWatchlist(tmdbId: number) {
    setWatchlistStatusByMovie((current) => ({
      ...current,
      [tmdbId]: {
        status: 'saving',
      },
    }));

    try {
      const body = selectedWatchlistId
        ? { tmdb_id: tmdbId, watchlist_id: selectedWatchlistId }
        : { tmdb_id: tmdbId };
      const response = await fetch('/api/watchlist', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as WatchlistResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not add this movie right now.');
      }

      setWatchlistStatusByMovie((current) => ({
        ...current,
        [tmdbId]: {
          status: 'saved',
          watchlistName: payload.watchlist?.name,
        },
      }));
    } catch {
      setWatchlistStatusByMovie((current) => ({
        ...current,
        [tmdbId]: {
          status: 'error',
        },
      }));
    }
  }

  const hasSearched = submittedQuery.length > 0;
  const resultCountLabel = getResultCountLabel(results.length);
  const selectedWatchlist =
    editableWatchlists.find((watchlist) => watchlist.id === selectedWatchlistId) ?? null;

  return (
    <section className="space-y-8">
      <div className="rounded-3xl bg-slate-950 px-8 py-10 text-white shadow-xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-200">
          Movie search
        </p>
        <h2 className="mt-3 text-4xl font-semibold leading-tight">
          Find release dates without exposing TMDb in the browser.
        </h2>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-200">
          Search requests go through moviecal&apos;s server-side endpoint, so TMDb
          credentials stay private while the app returns normalized results.
        </p>

        <form
          className="mt-6 flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();

            const nextQuery = query.trim();

            startTransition(() => {
              router.replace(getSearchHref(pathname, nextQuery));
              setSubmittedQuery(nextQuery);
              setSearchNonce((current) => current + 1);
            });
          }}
        >
          <label className="flex-1">
            <span className="sr-only">Search for a movie</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              type="search"
              name="q"
              placeholder="Search by title"
              className="w-full rounded-2xl border border-white/10 bg-white px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-sky-400"
            />
          </label>
          <button
            type="submit"
            className="rounded-2xl bg-sky-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-300"
          >
            Search
          </button>
        </form>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {status === 'idle' ? (
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-slate-950">
              Search the TMDb-backed catalog
            </h3>
            <p className="text-sm leading-6 text-slate-600">
              Enter a title to see release dates, result summaries, and watchlist
              actions from the app&apos;s server-side movie search endpoint.
            </p>
          </div>
        ) : null}

        {status === 'loading' ? (
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-slate-950">Searching…</h3>
            <p className="text-sm leading-6 text-slate-600">
              Looking up matches for{' '}
              <span className="font-medium text-slate-950">
                {submittedQuery}
              </span>
              .
            </p>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
            <p className="font-semibold text-rose-900">Search unavailable</p>
            <p className="mt-2 leading-6">{errorMessage}</p>
          </div>
        ) : null}

        {status === 'success' && hasSearched && results.length === 0 ? (
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-slate-950">No matches yet</h3>
            <p className="text-sm leading-6 text-slate-600">
              No movies matched{' '}
              <span className="font-medium text-slate-950">{submittedQuery}</span>.
              Try another title or a broader search.
            </p>
          </div>
        ) : null}

        {status === 'success' && results.length > 0 ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  Search results
                </h3>
                <p className="text-sm text-slate-600">
                  {resultCountLabel} for{' '}
                  <span className="font-medium text-slate-950">{submittedQuery}</span>
                </p>
              </div>
              {!isAuthenticated ? (
                <Link
                  href={getWatchlistSignInHref(pathname, submittedQuery)}
                  className="text-sm font-medium text-sky-700 hover:text-sky-800"
                >
                  Sign in to add movies to your watchlist
                </Link>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-slate-500">
                    Signed-in users can add results to an authorized watchlist from here.
                  </p>
                  {editableWatchlists.length > 0 ? (
                    <label className="flex items-center gap-2 text-sm text-slate-600">
                      <span>Save to</span>
                      <select
                        aria-label="Save to"
                        value={selectedWatchlistId}
                        onChange={(event) => {
                          setSelectedWatchlistId(event.target.value);
                        }}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
                      >
                        {editableWatchlists.map((watchlist) => (
                          <option key={watchlist.id} value={watchlist.id}>
                            {watchlist.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : watchlistLoadFailed ? (
                    <p className="text-sm text-amber-600">
                      Could not load your watchlists. Search is still available.
                    </p>
                  ) : (
                    <p className="text-sm text-slate-500">
                      You can view shared watchlists, but none of your current targets allow edits.
                    </p>
                  )}
                </div>
              )}
            </div>

            {isAuthenticated && readOnlyWatchlists.length > 0 ? (
              <p className="text-sm text-slate-500">
                Read-only watchlists: {readOnlyWatchlists.map((watchlist) => watchlist.name).join(', ')}.
              </p>
            ) : null}

            <ul className="grid gap-4">
              {results.map((movie) => {
                const watchlistState = watchlistStatusByMovie[movie.tmdbId];
                const watchlistStatus = watchlistState?.status ?? 'idle';

                return (
                  <li
                    key={movie.tmdbId}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-3">
                        <div className="flex items-start gap-3">
                          <MoviePoster posterPath={movie.posterPath} title={movie.title} />
                          <div className="min-w-0 break-words">
                          <h4 className="text-xl font-semibold text-slate-950">
                            {movie.title}
                          </h4>
                          <p className="mt-1 text-sm font-medium text-sky-700">
                            {formatReleaseDate(movie.releaseDate)}
                          </p>
                          </div>
                        </div>
                        <p className="max-w-2xl text-sm leading-6 text-slate-600">
                          {movie.overview ?? 'No overview is available for this title yet.'}
                        </p>
                      </div>

                      <div className="shrink-0 sm:w-48">
                        {isAuthenticated && editableWatchlists.length === 0 ? (
                          <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">
                            {watchlistLoadFailed
                              ? 'Could not load your watchlists. Search is still available.'
                              : 'Your current watchlist memberships are read-only, so you cannot add this movie from search.'}
                          </div>
                        ) : isAuthenticated ? (
                          <div className="space-y-2">
                            <button
                              type="button"
                              onClick={() => {
                                void addToWatchlist(movie.tmdbId);
                              }}
                              disabled={watchlistStatus === 'saving' || !selectedWatchlist}
                              className="w-full rounded-xl bg-sky-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-sky-400"
                            >
                              {watchlistStatus === 'saving'
                                ? 'Adding...'
                                : watchlistStatus === 'saved'
                                  ? 'Added'
                                  : 'Add to watchlist'}
                            </button>
                            <p className="text-xs leading-5 text-slate-500">
                              {getWatchlistStatusMessage(
                                watchlistState,
                                selectedWatchlist?.name ?? null,
                              )}
                            </p>
                          </div>
                        ) : (
                          <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">
                            Sign in to save this movie to your private watchlist.
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
