// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WatchlistDetailClient } from '../src/app/watchlist/watchlist-detail-client';
import {
  buildWatchlistItem,
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
