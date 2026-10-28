// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WatchlistPageClient } from '../src/app/watchlist/watchlist-page-client';
import {
  buildWatchlistItem,
  buildWatchlistSummary,
} from './support';

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
        initialWatchlists={[buildWatchlistSummary()]}
        overviewErrorMessage={null}
        personalItemsErrorMessage={null}
        personalWatchlistId="personal-watchlist-1"
      />,
    );

    expect(screen.getByText('Your watchlist is empty')).toBeTruthy();
    expect(screen.getByText('Watchlists you can access')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Search movies' }).getAttribute('href')).toBe('/search');
    expect(screen.queryByText('No watchlists yet')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps populated watchlists without empty-state actions', () => {
    render(
      <WatchlistPageClient
        initialItems={[buildWatchlistItem()]}
        initialWatchlists={[buildWatchlistSummary()]}
        overviewErrorMessage={null}
        personalItemsErrorMessage={null}
        personalWatchlistId="personal-watchlist-1"
      />,
    );

    expect(screen.getByRole('heading', { name: 'The Matrix' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.queryByText('Your watchlist is empty')).toBeNull();
    expect(screen.queryByText('No watchlists yet')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Search movies' })).toBeNull();
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
        initialItems={[buildWatchlistItem()]}
        initialWatchlists={[buildWatchlistSummary()]}
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
        initialItems={[buildWatchlistItem()]}
        initialWatchlists={[buildWatchlistSummary()]}
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

  it('creates a first watchlist using the existing form and replaces the empty overview', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        watchlist: buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        }),
      }),
    } as Response);

    render(
      <WatchlistPageClient
        initialItems={[]}
        initialWatchlists={[]}
        overviewErrorMessage={null}
        personalItemsErrorMessage={null}
        personalWatchlistId={null}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No watchlists yet' })).toBeTruthy();
    expect(screen.getByText('Use the form to create your first shared watchlist and plan a movie night.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create your first watchlist' }).getAttribute('href')).toBe('#watchlist-name');
    expect(screen.getByLabelText('Watchlist name').id).toBe('watchlist-name');

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
    expect(screen.queryByText('No watchlists yet')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create your first watchlist' })).toBeNull();
  });

  it('links accessible watchlists to their detail pages', () => {
    render(
      <WatchlistPageClient
        initialItems={[]}
        initialWatchlists={[
          buildWatchlistSummary(),
          buildWatchlistSummary({
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
        initialItems={[buildWatchlistItem()]}
        initialWatchlists={[]}
        overviewErrorMessage="Could not load your watchlists right now."
        personalItemsErrorMessage={null}
        personalWatchlistId={null}
      />,
    );

    expect(screen.getByText('Watchlist overview unavailable')).toBeTruthy();
    expect(screen.queryByText('No watchlists yet')).toBeNull();
    expect(screen.getByText('Could not load your watchlists right now.')).toBeTruthy();
    expect(screen.getByText('Personal watchlist')).toBeTruthy();
    expect(screen.getByText('The Matrix')).toBeTruthy();
  });

  it('shows the personal items error without hiding the watchlist overview', () => {
    render(
      <WatchlistPageClient
        initialItems={[]}
        initialWatchlists={[
          buildWatchlistSummary(),
          buildWatchlistSummary({
            id: 'shared-watchlist-1',
            kind: 'shared',
            name: 'Friday movie night',
          }),
        ]}
        overviewErrorMessage={null}
        personalItemsErrorMessage="Could not load your personal watchlist right now."
        personalWatchlistId="personal-watchlist-1"
      />,
    );

    expect(screen.getByText('Personal watchlist unavailable')).toBeTruthy();
    expect(
      screen.getByText('Could not load your personal watchlist right now.'),
    ).toBeTruthy();
    expect(screen.getAllByText('Friday movie night').length).toBeGreaterThan(0);
    expect(screen.getByText('Watchlists you can access')).toBeTruthy();
    expect(screen.queryByText('Your watchlist is empty')).toBeNull();
  });
});
