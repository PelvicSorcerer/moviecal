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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim() ?? '';

  if (!query) {
    return NextResponse.json(
      { error: 'Search query "q" is required.' },
      { status: 400 },
    );
  }

  try {
    if (isE2ETestModeEnabled()) {
      try {
        const results = searchE2EMovieCatalog(query);

        return NextResponse.json({ results });
      } catch (error) {
        return NextResponse.json(
          {
            error: error instanceof Error
              ? error.message
              : 'Movie search is unavailable right now.',
          },
          { status: 503 },
        );
      }
    }

    const results = await searchMovies(query);

    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof TMDbEnvironmentError) {
      return NextResponse.json(
        { error: 'Movie search is unavailable until TMDb is configured.' },
        { status: 503 },
      );
    }

    if (error instanceof TMDbRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    throw error;
  }
}
