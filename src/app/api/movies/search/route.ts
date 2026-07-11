import { NextResponse } from 'next/server';

import {
  isE2ETestModeEnabled,
  searchE2EMovieCatalog,
} from '../../../../lib/e2e/fixtures';
import {
  searchMovies,
  TMDbEnvironmentError,
  TMDbRequestError,
} from '../../../../lib/tmdb/client';
import { apiError, handleDomainError } from '../../../../lib/api/response';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim() ?? '';

  if (!query) {
    return apiError('Search query "q" is required.', 400);
  }

  try {
    if (isE2ETestModeEnabled()) {
      try {
        const results = searchE2EMovieCatalog(query);

        return NextResponse.json({ results });
      } catch (error) {
        return apiError(
          error instanceof Error ? error.message : 'Movie search is unavailable right now.',
          503,
        );
      }
    }

    const results = await searchMovies(query);

    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof TMDbEnvironmentError) {
      return apiError('Movie search is unavailable until TMDb is configured.', 503);
    }

    if (error instanceof TMDbRequestError) {
      return apiError(error.message, error.status);
    }

    return handleDomainError(error);
  }
}
