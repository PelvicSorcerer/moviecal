import { timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { getServerCronEnv, CronEnvironmentError } from '../../../../lib/cron/env';
import { refreshTrackedMovies } from '../../../../lib/release-refresh';
import {
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';
import { getMovieDetails } from '../../../../lib/tmdb/client';
import { TMDbEnvironmentError } from '../../../../lib/tmdb/env';
import { apiError, handleDomainError } from '../../../../lib/api/response';

function readCronSecret(request: NextRequest): string | null {
  const authorization = request.headers.get('authorization')?.trim();

  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim();

    return token || null;
  }

  const headerSecret = request.headers.get('x-cron-secret')?.trim();

  return headerSecret || null;
}

function isAuthorizedRequest(request: NextRequest): boolean {
  const providedSecret = readCronSecret(request);

  if (!providedSecret) {
    return false;
  }

  const { secret } = getServerCronEnv();
  const expectedBytes = Buffer.from(secret);
  const providedBytes = Buffer.from(providedSecret);

  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

function createRefreshRepository() {
  const adminClient = createServerSupabaseServiceRoleClient();

  return createSupabaseWatchlistRepository({
    adminClient,
    userClient: adminClient,
  });
}

async function handleRefreshRequest(request: NextRequest) {
  try {
    if (!isAuthorizedRequest(request)) {
      return apiError('Unauthorized.', 401);
    }

    const result = await refreshTrackedMovies({
      getMovieDetails,
      repository: createRefreshRepository(),
    });

    if (result.failedMovies > 0) {
      return NextResponse.json(
        {
          error: 'One or more movie refreshes failed.',
          ...result,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CronEnvironmentError) {
      return apiError('Release refresh is unavailable until cron auth is configured.', 503);
    }

    if (error instanceof TMDbEnvironmentError) {
      return apiError('Release refresh is unavailable until TMDb is configured.', 503);
    }

    return handleDomainError(error);
  }
}

export async function GET(request: NextRequest) {
  return handleRefreshRequest(request);
}

export async function POST(request: NextRequest) {
  return handleRefreshRequest(request);
}
