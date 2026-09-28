// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SharedWatchlistPageClient } from '../src/app/watchlist/[watchlistId]/shared-watchlist-page-client';
import { buildWatchlistSummary } from './support';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

describe('SharedWatchlistPageClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    router.push.mockReset();
    router.refresh.mockReset();
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

    // Nothing is sent until the owner confirms.
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));

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
    expect(screen.queryByRole('button', { name: 'Leave watchlist' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete watchlist' })).toBeNull();
  });

  it('cancels a pending member removal without calling the API', () => {
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
        watchlist={buildWatchlistSummary({ id: 'shared-watchlist-1', kind: 'shared' })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Remove access' })).toBeTruthy();
    expect(screen.getByText('friend@moviecal.test')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the member and shows the error when removal is refused', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Watchlist access denied.' }),
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
        watchlist={buildWatchlistSummary({ id: 'shared-watchlist-1', kind: 'shared' })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));

    await waitFor(() => {
      expect(screen.getByText('Watchlist access denied.')).toBeTruthy();
    });
    expect(screen.getByText('friend@moviecal.test')).toBeTruthy();
  });

  describe('editor leave', () => {
    function renderAsEditor() {
      render(
        <SharedWatchlistPageClient
          activeInviteLinkExists={false}
          canLeave
          initialMembers={[]}
          ownerCanManage={false}
          watchlist={buildWatchlistSummary({
            id: 'shared-watchlist-1',
            kind: 'shared',
            name: 'Friday movie night',
          })}
        />,
      );
    }

    it('asks for confirmation, then leaves and returns to the overview', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ left: true }),
      } as Response);
      renderAsEditor();

      fireEvent.click(screen.getByRole('button', { name: 'Leave watchlist' }));
      expect(fetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm leave' }));

      await waitFor(() => {
        expect(router.push).toHaveBeenCalledWith('/watchlist');
      });
      expect(fetch).toHaveBeenCalledWith(
        '/api/watchlist/shared/shared-watchlist-1/membership',
        { method: 'DELETE' },
      );
    });

    it('can cancel leaving', () => {
      renderAsEditor();

      fireEvent.click(screen.getByRole('button', { name: 'Leave watchlist' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByRole('button', { name: 'Leave watchlist' })).toBeTruthy();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('shows the error and stays on the page when leaving fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Watchlist access denied.' }),
      } as Response);
      router.push.mockClear();
      renderAsEditor();

      fireEvent.click(screen.getByRole('button', { name: 'Leave watchlist' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm leave' }));

      await waitFor(() => {
        expect(screen.getByText('Watchlist access denied.')).toBeTruthy();
      });
      expect(router.push).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Leave watchlist' })).toBeTruthy();
    });
  });

  it('cancelling a delete leaves the watchlist intact and issues no request', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Delete watchlist' }));

    expect(
      screen.getByText('Permanently delete "Friday movie night"?'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Delete watchlist' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('confirming a delete calls the delete route and navigates back to the overview', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ deleted: true, watchlistId: 'shared-watchlist-1' }),
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

    fireEvent.click(screen.getByRole('button', { name: 'Delete watchlist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/watchlist');
    });

    expect(fetch).toHaveBeenCalledWith('/api/watchlist/shared/shared-watchlist-1', {
      method: 'DELETE',
    });
  });

  it('shows an error and stays put when deletion fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Watchlist access denied.' }),
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

    fireEvent.click(screen.getByRole('button', { name: 'Delete watchlist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => {
      expect(screen.getByText('Watchlist access denied.')).toBeTruthy();
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete watchlist' })).toBeTruthy();
  });
});
