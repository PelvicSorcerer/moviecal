// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WatchlistPageClient } from '../src/app/watchlist/watchlist-page-client';
import type { WatchlistItem } from '../src/lib/watchlist';

function buildItem(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    id: 'watchlist-item-1',
    addedAt: '2026-06-13T05:00:00.000Z',
    movie: {
      id: 42,
      tmdbId: 603,
      title: 'The Matrix',
      releaseDate: '1999-03-31',
      overview: 'A hacker discovers the truth.',
      posterPath: '/matrix.jpg',
    },
    ...overrides,
  };
}

describe('WatchlistPageClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders an empty state when there are no watchlist items', () => {
    render(<WatchlistPageClient initialItems={[]} />);

    expect(screen.getByText('Your watchlist is empty')).toBeTruthy();
  });

  it('removes an item from the UI after a successful delete request', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        deleted: true,
        id: 'watchlist-item-1',
      }),
    } as Response);

    render(<WatchlistPageClient initialItems={[buildItem()]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.queryByText('The Matrix')).toBeNull();
    });

    expect(fetch).toHaveBeenCalledWith('/api/watchlist/watchlist-item-1', {
      method: 'DELETE',
    });
    expect(
      screen.getByText('Removed The Matrix from your watchlist.'),
    ).toBeTruthy();
  });

  it('keeps the item visible and shows an error when delete fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'Watchlist item not found.',
      }),
    } as Response);

    render(<WatchlistPageClient initialItems={[buildItem()]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByText('Watchlist update failed')).toBeTruthy();
    });

    expect(screen.getByText('The Matrix')).toBeTruthy();
    expect(screen.getByText('Watchlist item not found.')).toBeTruthy();
  });
});
