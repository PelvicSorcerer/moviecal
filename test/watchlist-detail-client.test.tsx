// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WatchlistDetailClient } from '../src/app/watchlist/watchlist-detail-client';
import {
  buildWatchlistItem,
  buildWatchlistMovie,
  buildWatchlistSummary,
} from './support';

describe('WatchlistDetailClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(['personal', 'shared'] as const)('links an empty %s watchlist to Search', (kind) => {
    render(
      <WatchlistDetailClient
        initialItems={[]}
        watchlist={buildWatchlistSummary({ kind, name: 'Movie night' })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'This watchlist is empty' })).toBeTruthy();
    expect(screen.getByText('Save movies from search and target Movie night to manage them here.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search movies' }).getAttribute('href')).toBe('/search');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('guides read-only members toward a watchlist they can edit', () => {
    render(
      <WatchlistDetailClient
        initialItems={[]}
        watchlist={buildWatchlistSummary({ kind: 'shared', canEdit: false })}
      />,
    );

    expect(screen.getByText('Read-only access')).toBeTruthy();
    expect(screen.getByText('Search for movies to save to a watchlist you can edit.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search movies' }).getAttribute('href')).toBe('/search');
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('renders populated lists without the empty-state action', () => {
    render(
      <WatchlistDetailClient
        initialItems={[buildWatchlistItem()]}
        watchlist={buildWatchlistSummary()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'The Matrix' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.queryByText('This watchlist is empty')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Search movies' })).toBeNull();
  });

  describe.each(['personal', 'shared'] as const)('%s watchlist release dates', (kind) => {
    it.each([
      ['2027-03-05', 'Mar 5, 2027'],
      ['2027-01-01', 'Jan 1, 2027'],
      [null, 'Release date TBA'],
      ['', 'Release date TBA'],
      ['2027-02-29', 'Release date TBA'],
    ])('renders %s as %s', (releaseDate, expected) => {
      render(
        <WatchlistDetailClient
          initialItems={[buildWatchlistItem({
            movie: buildWatchlistMovie(undefined, { releaseDate }),
          })]}
          watchlist={buildWatchlistSummary({ kind })}
        />,
      );

      expect(screen.getByText(expected)).toBeTruthy();
      expect(screen.queryByText('Invalid Date')).toBeNull();
      expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('removes an item from the targeted watchlist detail page', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        deleted: true,
        id: 'watchlist-item-1',
      }),
    } as Response);

    render(
      <WatchlistDetailClient
        initialItems={[buildWatchlistItem()]}
        watchlist={buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.queryByText('The Matrix')).toBeNull();
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/watchlist/watchlist-item-1?watchlist_id=shared-watchlist-1',
      {
        method: 'DELETE',
      },
    );
    expect(
      screen.getByText('Removed The Matrix from Friday movie night.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search movies' })).toBeTruthy();
  });

  it('keeps the movie visible when the targeted delete fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'Watchlist item not found.',
      }),
    } as Response);

    render(
      <WatchlistDetailClient
        initialItems={[buildWatchlistItem()]}
        watchlist={buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByText('Watchlist update failed')).toBeTruthy();
    });

    expect(screen.getByText('The Matrix')).toBeTruthy();
    expect(screen.getByText('Watchlist item not found.')).toBeTruthy();
  });

  it('shows a read-only state and hides remove actions for non-editable memberships', () => {
    render(
      <WatchlistDetailClient
        initialItems={[buildWatchlistItem()]}
        watchlist={buildWatchlistSummary({
          canEdit: false,
          name: 'Curated picks',
        })}
      />,
    );

    expect(screen.getByText('Read-only access')).toBeTruthy();
    expect(
      screen.getByText(
        'You can review the movies saved to Curated picks, but your membership does not allow edits for this watchlist.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
