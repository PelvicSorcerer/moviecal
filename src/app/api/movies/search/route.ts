import { NextResponse } from 'next/server';

import {
  isE2ETestModeEnabled,
  searchE2EMovieCatalog,
} from '../../../../lib/e2e/fixtures';
import {
  searchMoviesPage,
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

  const rawPage = searchParams.get('page');
  const page = rawPage === null ? 1 : Number(rawPage);

  if ((rawPage !== null && !/^\d+$/.test(rawPage))
    || !Number.isInteger(page) || page < 1 || page > 500) {
    return apiError('Page must be an integer between 1 and 500.', 400);
  }

  try {
    if (isE2ETestModeEnabled()) {
      try {
        const results = searchE2EMovieCatalog(query);

        return NextResponse.json({
          results: page === 1 ? results : [], page, totalPages: 1, totalResults: results.length,
        });
      } catch (error) {
        return apiError(
          error instanceof Error ? error.message : 'Movie search is unavailable right now.',
          503,
        );
      }
    }

    const results = await searchMoviesPage(query, page);

    return NextResponse.json(results);
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
