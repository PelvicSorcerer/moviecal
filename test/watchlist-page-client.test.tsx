// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WatchlistPageClient } from '../src/app/watchlist/watchlist-page-client';
import type { WatchlistItem, WatchlistSummary } from '../src/lib/watchlist';

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

function buildWatchlist(
  overrides: Partial<WatchlistSummary> = {},
): WatchlistSummary {
  return {
    canEdit: true,
    id: 'personal-watchlist-1',
    kind: 'personal',
    name: 'My watchlist',
    ownerUserId: 'user-1',
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
    render(
      <WatchlistPageClient
        initialItems={[]}
        initialWatchlists={[buildWatchlist()]}
        overviewErrorMessage={null}
        personalItemsErrorMessage={null}
        personalWatchlistId="personal-watchlist-1"
      />,
    );

    expect(screen.getByText('Your watchlist is empty')).toBeTruthy();
    expect(screen.getByText('Watchlists you can access')).toBeTruthy();
  });

  it('removes an item from the UI after a successful delete request', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        deleted: true,
        id: 'watchlist-item-1',
      }),
    } as Response);

    render(
      <WatchlistPageClient
        initialItems={[buildItem()]}
        initialWatchlists={[buildWatchlist()]}
        overviewErrorMessage={null}
        personalItemsErrorMessage={null}
        personalWatchlistId="personal-watchlist-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.queryByText('The Matrix')).toBeNull();
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/watchlist/watchlist-item-1?watchlist_id=personal-watchlist-1',
      {
        method: 'DELETE',
      },
    );
    expect(
      screen.getByText('Removed The Matrix from My watchlist.'),
    ).toBeTruthy();
  });

  it('keeps the item visible and shows an error when delete fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'Watchlist item not found.',
      }),
    } as Response);

    render(
      <WatchlistPageClient
        initialItems={[buildItem()]}
        initialWatchlists={[buildWatchlist()]}
        overviewErrorMessage={null}
        personalItemsErrorMessage={null}
        personalWatchlistId="personal-watchlist-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByText('Watchlist update failed')).toBeTruthy();
    });

    expect(screen.getByText('The Matrix')).toBeTruthy();
    expect(screen.getByText('Watchlist item not found.')).toBeTruthy();
  });

  it('creates a shared watchlist and appends it to the overview', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        watchlist: buildWatchlist({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        }),
      }),
    } as Response);

    render(
      <WatchlistPageClient
        initialItems={[]}
        initialWatchlists={[buildWatchlist()]}
        overviewErrorMessage={null}
        personalItemsErrorMessage={null}
        personalWatchlistId="personal-watchlist-1"
      />,
    );

    fireEvent.change(screen.getByLabelText('Watchlist name'), {
      target: { value: 'Friday movie night' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create shared watchlist' }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Friday movie night' }),
      ).toBeTruthy();
    });

    expect(fetch).toHaveBeenCalledWith('/api/watchlist/shared', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Friday movie night' }),
    });
    expect(
      screen.getByText('Created shared watchlist Friday movie night.'),
    ).toBeTruthy();
  });

  it('links accessible watchlists to their detail pages', () => {
    render(
      <WatchlistPageClient
        initialItems={[]}
        initialWatchlists={[
          buildWatchlist(),
          buildWatchlist({
            id: 'shared-watchlist-1',
            kind: 'shared',
            name: 'Friday movie night',
          }),
        ]}
        overviewErrorMessage={null}
        personalItemsErrorMessage={null}
        personalWatchlistId="personal-watchlist-1"
      />,
    );

    expect(screen.getByRole('link', { name: 'My watchlist' }).getAttribute('href')).toBe(
      '/watchlist/personal-watchlist-1',
    );
    expect(
      screen.getAllByRole('link', { name: 'Friday movie night' })[0]?.getAttribute('href'),
    ).toBe('/watchlist/shared-watchlist-1');
  });

  it('shows the overview error without hiding the personal watchlist section', () => {
    render(
      <WatchlistPageClient
        initialItems={[buildItem()]}
        initialWatchlists={[]}
        overviewErrorMessage="Could not load your watchlists right now."
        personalItemsErrorMessage={null}
        personalWatchlistId={null}
      />,
    );

    expect(screen.getByText('Watchlist overview unavailable')).toBeTruthy();
    expect(screen.getByText('Could not load your watchlists right now.')).toBeTruthy();
    expect(screen.getByText('Personal watchlist')).toBeTruthy();
    expect(screen.getByText('The Matrix')).toBeTruthy();
  });
});
