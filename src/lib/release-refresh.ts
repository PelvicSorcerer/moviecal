import { TMDbEnvironmentError } from './tmdb/env';
import type { NormalizedMovieDetail } from './tmdb/client';
import type { WatchlistRepository } from './watchlist';

export interface ReleaseRefreshResult {
  failedMovieIds: number[];
  failedMovies: number;
  refreshedMovies: number;
  trackedMovies: number;
}

export async function selectTrackedMovieIds(
  repository: WatchlistRepository,
): Promise<number[]> {
  const trackedMovies = await repository.listTrackedMovies();
  return [
    ...new Set(
      trackedMovies
        .map((movie) => movie.tmdb_id)
        .filter((tmdbId) => Number.isInteger(tmdbId) && tmdbId > 0),
    ),
  ];
}

export async function fetchMovieDetail(
  tmdbId: number,
  getMovieDetails: (id: number) => Promise<NormalizedMovieDetail>,
): Promise<
  | { success: true; detail: NormalizedMovieDetail }
  | { success: false; tmdbId: number; error: unknown }
> {
  try {
    const detail = await getMovieDetails(tmdbId);
    return { success: true, detail };
  } catch (error) {
    if (error instanceof TMDbEnvironmentError) {
      throw error;
    }
    return { success: false, tmdbId, error };
  }
}

export async function persistMovieUpdate(
  detail: NormalizedMovieDetail,
  repository: WatchlistRepository,
): Promise<void> {
  await repository.upsertMovie(detail);
}

export async function runRefreshPipeline(args: {
  repository: WatchlistRepository;
  getMovieDetails: (id: number) => Promise<NormalizedMovieDetail>;
}): Promise<ReleaseRefreshResult> {
  const trackedTmdbIds = await selectTrackedMovieIds(args.repository);

  let refreshedMovies = 0;
  const failedMovieIds: number[] = [];

  for (const tmdbId of trackedTmdbIds) {
    const fetchResult = await fetchMovieDetail(tmdbId, args.getMovieDetails);

    if (!fetchResult.success) {
      failedMovieIds.push(tmdbId);
      continue;
    }

    try {
      await persistMovieUpdate(fetchResult.detail, args.repository);
      refreshedMovies += 1;
    } catch {
      failedMovieIds.push(tmdbId);
    }
  }

  return {
    failedMovieIds,
    failedMovies: failedMovieIds.length,
    refreshedMovies,
    trackedMovies: trackedTmdbIds.length,
  };
}
