import { describe, expect, it } from 'vitest';

import { apiError, handleDomainError } from '../../../src/lib/api/response';
import {
  WatchlistAccessError,
  WatchlistDataError,
  WatchlistInputError,
  WatchlistNotFoundError,
} from '../../../src/lib/watchlist';

describe('apiError', () => {
  it('returns a JSON response with the given message and status', async () => {
    const response = apiError('Something went wrong.', 422);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'Something went wrong.' });
  });

  it('returns a 400 response with the given message', async () => {
    const response = apiError('Bad input.', 400);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Bad input.' });
  });

  it('returns a 500 response with the given message', async () => {
    const response = apiError('Server failed.', 500);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Server failed.' });
  });
});

describe('handleDomainError', () => {
  it('maps WatchlistInputError to 400 with the error message', async () => {
    const error = new WatchlistInputError('A valid tmdb_id is required.');
    const response = handleDomainError(error);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'A valid tmdb_id is required.',
    });
  });

  it('maps WatchlistNotFoundError to 404 with the error message', async () => {
    const error = new WatchlistNotFoundError('Watchlist not found.');
    const response = handleDomainError(error);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Watchlist not found.' });
  });

  it('maps WatchlistAccessError to 403 with the error message', async () => {
    const error = new WatchlistAccessError('Watchlist access denied.');
    const response = handleDomainError(error);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Watchlist access denied.',
    });
  });

  it('maps WatchlistDataError to 500 with the error message', async () => {
    const error = new WatchlistDataError('Watchlist item is missing movie metadata.');
    const response = handleDomainError(error);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Watchlist item is missing movie metadata.',
    });
  });

  it('returns 500 with a generic message for unknown errors', async () => {
    const error = new Error('Something totally unexpected happened.');
    const response = handleDomainError(error);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Internal server error.',
    });
  });

  it('returns 500 with a generic message for non-Error unknown values', async () => {
    const response = handleDomainError('unexpected string error');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Internal server error.',
    });
  });
});
