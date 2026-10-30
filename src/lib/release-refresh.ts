import { TMDbEnvironmentError } from './tmdb/env';
import type { NormalizedMovieDetail } from './tmdb/client';
import type { WatchlistMovieRow, WatchlistRepository } from './watchlist';

export const MAX_RELEASE_DATE_CHANGES = 100;

export interface ReleaseRefreshResult {
  changedMovies: number;
  unchangedMovies: number;
  releaseDateChanges: { tmdbId: number; from: string | null; to: string | null }[];
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

function isMovieUnchanged(stored: WatchlistMovieRow, detail: NormalizedMovieDetail): boolean {
  const metadata =
    typeof stored.raw_json === 'object' && stored.raw_json !== null && !Array.isArray(stored.raw_json)
      ? stored.raw_json
      : {};
  const normalizeString = (value: unknown): string | null =>
    typeof value === 'string' ? value.trim() || null : null;

  return stored.title === detail.title
    && stored.release_date === detail.releaseDate
    && normalizeString(metadata.poster_path) === detail.posterPath
    && normalizeString(metadata.overview) === detail.overview;
}

export async function runRefreshPipeline(args: {
  repository: WatchlistRepository;
  getMovieDetails: (id: number) => Promise<NormalizedMovieDetail>;
}): Promise<ReleaseRefreshResult> {
  const trackedTmdbIds = await selectTrackedMovieIds(args.repository);

  let refreshedMovies = 0;
  let changedMovies = 0;
  let unchangedMovies = 0;
  const releaseDateChanges: ReleaseRefreshResult['releaseDateChanges'] = [];
  const failedMovieIds: number[] = [];

  for (const tmdbId of trackedTmdbIds) {
    const fetchResult = await fetchMovieDetail(tmdbId, args.getMovieDetails);

    if (!fetchResult.success) {
      failedMovieIds.push(tmdbId);
      continue;
    }

    try {
      const detail = fetchResult.detail;
      const stored = await args.repository.findMovieByTmdbId(tmdbId);

      if (stored && isMovieUnchanged(stored, detail)) {
        unchangedMovies += 1;
      } else {
        await persistMovieUpdate(detail, args.repository);
        changedMovies += 1;

        if (stored && stored.release_date !== detail.releaseDate
          && releaseDateChanges.length < MAX_RELEASE_DATE_CHANGES) {
          releaseDateChanges.push({ tmdbId, from: stored.release_date, to: detail.releaseDate });
        }
      }
      refreshedMovies += 1;
    } catch {
      failedMovieIds.push(tmdbId);
    }
  }

  return {
    changedMovies,
    unchangedMovies,
    releaseDateChanges,
    failedMovieIds,
    failedMovies: failedMovieIds.length,
    refreshedMovies,
    trackedMovies: trackedTmdbIds.length,
  };
}
