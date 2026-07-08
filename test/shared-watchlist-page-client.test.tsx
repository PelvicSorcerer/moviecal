// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SharedWatchlistPageClient } from '../src/app/watchlist/[watchlistId]/shared-watchlist-page-client';
import { buildWatchlistSummary } from './support';

describe('SharedWatchlistPageClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('creates an invite link and shows the returned URL', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        inviteUrl: 'https://moviecal.test/watchlist/invite/secret-token',
      }),
    } as Response);

    render(
      <SharedWatchlistPageClient
        activeInviteLinkExists={false}
        initialMembers={[
          {
            acceptedAt: null,
            canRemove: false,
            email: 'owner@moviecal.test',
            id: 'owner:user-1',
            isCurrentUser: true,
            isOwner: true,
            role: 'owner',
          },
        ]}
        ownerCanManage
        watchlist={buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }));

    await waitFor(() => {
      expect(
        screen.getByDisplayValue(
          'https://moviecal.test/watchlist/invite/secret-token',
        ),
      ).toBeTruthy();
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/watchlist/shared/shared-watchlist-1/invite',
      { method: 'POST' },
    );
    expect(
      screen.getByText('Created an invite link for this shared watchlist.'),
    ).toBeTruthy();
  });

  it('shows a rotate message when an active invite link already exists', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        inviteUrl: 'https://moviecal.test/watchlist/invite/rotated-token',
      }),
    } as Response);

    render(
      <SharedWatchlistPageClient
        activeInviteLinkExists
        initialMembers={[]}
        ownerCanManage
        watchlist={buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rotate invite link' }));

    await waitFor(() => {
      expect(
        screen.getByText('Rotated the invite link for this shared watchlist.'),
      ).toBeTruthy();
    });
  });

  it('removes a member and updates the member list', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    render(
      <SharedWatchlistPageClient
        activeInviteLinkExists={false}
        initialMembers={[
          {
            acceptedAt: '2026-06-20T00:00:00.000Z',
            canRemove: true,
            email: 'friend@moviecal.test',
            id: 'membership-1',
            isCurrentUser: false,
            isOwner: false,
            role: 'editor',
          },
        ]}
        ownerCanManage
        watchlist={buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove access' }));

    await waitFor(() => {
      expect(screen.queryByText('friend@moviecal.test')).toBeNull();
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/watchlist/shared/shared-watchlist-1/members/membership-1',
      { method: 'DELETE' },
    );
    expect(
      screen.getByText('Removed friend@moviecal.test from Friday movie night.'),
    ).toBeTruthy();
  });

  it('shows an error when invite link creation fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'Watchlist access denied.',
      }),
    } as Response);

    render(
      <SharedWatchlistPageClient
        activeInviteLinkExists={false}
        initialMembers={[]}
        ownerCanManage
        watchlist={buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }));

    await waitFor(() => {
      expect(screen.getByText('Shared watchlist update failed')).toBeTruthy();
    });

    expect(screen.getByText('Watchlist access denied.')).toBeTruthy();
  });

  it('hides owner management controls for non-owner members', () => {
    render(
      <SharedWatchlistPageClient
        activeInviteLinkExists={false}
        initialMembers={[
          {
            acceptedAt: '2026-06-20T00:00:00.000Z',
            canRemove: false,
            email: 'friend@moviecal.test',
            id: 'membership-1',
            isCurrentUser: true,
            isOwner: false,
            role: 'editor',
          },
        ]}
        ownerCanManage={false}
        watchlist={buildWatchlistSummary({
          id: 'shared-watchlist-1',
          kind: 'shared',
          name: 'Friday movie night',
        })}
      />,
    );

    expect(screen.getByText('Owner-managed access')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create invite link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove access' })).toBeNull();
  });
});
