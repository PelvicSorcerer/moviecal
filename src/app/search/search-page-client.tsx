'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  startTransition,
  useEffect,
  useState,
} from 'react';

import type { NormalizedMovieSummary } from '../../lib/tmdb/client';

type SearchStatus = 'idle' | 'loading' | 'success' | 'error';
export type WatchlistStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SearchResponse {
  results?: NormalizedMovieSummary[];
  error?: string;
}

interface WatchlistResponse {
  error?: string;
}

export interface SearchPageClientProps {
  initialQuery: string;
  isAuthenticated: boolean;
}

export function formatReleaseDate(releaseDate: string | null): string {
  if (!releaseDate) {
    return 'Release date TBD';
  }

  const parsedDate = new Date(`${releaseDate}T00:00:00Z`);

  if (Number.isNaN(parsedDate.getTime())) {
    return 'Release date TBD';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsedDate);
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

export function getWatchlistStatusMessage(status: WatchlistStatus): string {
  if (status === 'error') {
    return 'Could not add this movie right now.';
  }

  if (status === 'saved') {
    return 'The authenticated add flow succeeded for this movie.';
  }

  return 'Add this result to your private watchlist.';
}

export function SearchPageClient({
  initialQuery,
  isAuthenticated,
}: SearchPageClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [searchNonce, setSearchNonce] = useState(0);
  const [status, setStatus] = useState<SearchStatus>(initialQuery ? 'loading' : 'idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<NormalizedMovieSummary[]>([]);
  const [watchlistStatusByMovie, setWatchlistStatusByMovie] = useState<
    Record<number, WatchlistStatus>
  >({});

  useEffect(() => {
    setQuery(initialQuery);
    setSubmittedQuery(initialQuery);
    setSearchNonce((current) => current + 1);
    setStatus(initialQuery ? 'loading' : 'idle');
    setErrorMessage(null);
  }, [initialQuery]);

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
      [tmdbId]: 'saving',
    }));

    try {
      const response = await fetch('/api/watchlist', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tmdb_id: tmdbId }),
      });

      const payload = (await response.json()) as WatchlistResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? 'Could not add this movie right now.');
      }

      setWatchlistStatusByMovie((current) => ({
        ...current,
        [tmdbId]: 'saved',
      }));
    } catch {
      setWatchlistStatusByMovie((current) => ({
        ...current,
        [tmdbId]: 'error',
      }));
    }
  }

  const hasSearched = submittedQuery.length > 0;
  const resultCountLabel = getResultCountLabel(results.length);

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
                <p className="text-sm text-slate-500">
                  Signed-in users can add results to their watchlist from here.
                </p>
              )}
            </div>

            <ul className="grid gap-4">
              {results.map((movie) => {
                const watchlistStatus = watchlistStatusByMovie[movie.tmdbId] ?? 'idle';

                return (
                  <li
                    key={movie.tmdbId}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-3">
                        <div>
                          <h4 className="text-xl font-semibold text-slate-950">
                            {movie.title}
                          </h4>
                          <p className="mt-1 text-sm font-medium text-sky-700">
                            {formatReleaseDate(movie.releaseDate)}
                          </p>
                        </div>
                        <p className="max-w-2xl text-sm leading-6 text-slate-600">
                          {movie.overview ?? 'No overview is available for this title yet.'}
                        </p>
                      </div>

                      <div className="sm:w-48">
                        {isAuthenticated ? (
                          <div className="space-y-2">
                            <button
                              type="button"
                              onClick={() => {
                                void addToWatchlist(movie.tmdbId);
                              }}
                              disabled={watchlistStatus === 'saving'}
                              className="w-full rounded-xl bg-sky-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-sky-400"
                            >
                              {watchlistStatus === 'saving'
                                ? 'Adding...'
                                : watchlistStatus === 'saved'
                                  ? 'Added'
                                  : 'Add to watchlist'}
                            </button>
                            <p className="text-xs leading-5 text-slate-500">
                              {getWatchlistStatusMessage(watchlistStatus)}
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
