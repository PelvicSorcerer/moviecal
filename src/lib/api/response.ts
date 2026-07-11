import { NextResponse } from 'next/server';

import {
  WatchlistAccessError,
  WatchlistDataError,
  WatchlistInputError,
  WatchlistNotFoundError,
} from '../watchlist';

/**
 * Constructs a JSON error response with shape `{ error: message }`.
 */
export function apiError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Maps known watchlist domain errors to the appropriate HTTP error response.
 * Returns 400 for WatchlistInputError, 404 for WatchlistNotFoundError,
 * 403 for WatchlistAccessError, 500 for WatchlistDataError, and a generic
 * 500 for any other error.
 *
 * Unexpected exceptions are absorbed here and mapped to a generic 500 JSON response.
 * They are not re-thrown, so Next.js error propagation does not fire for these cases.
 * If monitoring is added later, instrument this fallback branch.
 */
export function handleDomainError(error: unknown): NextResponse {
  if (
    error instanceof WatchlistInputError
    || error instanceof WatchlistNotFoundError
    || error instanceof WatchlistAccessError
    || error instanceof WatchlistDataError
  ) {
    return apiError(error.message, error.status);
  }

  return apiError('Internal server error.', 500);
}
