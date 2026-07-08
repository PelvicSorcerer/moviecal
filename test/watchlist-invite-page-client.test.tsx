// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WatchlistInvitePageClient } from '../src/app/watchlist/invite/[token]/watchlist-invite-page-client';

const push = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push,
    refresh,
  }),
}));

describe('WatchlistInvitePageClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    push.mockReset();
    refresh.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('accepts an invite and navigates to the shared watchlist detail page', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        joined: true,
        watchlist: {
          id: 'shared-watchlist-1',
          name: 'Friday movie night',
        },
      }),
    } as Response);

    render(
      <WatchlistInvitePageClient
        canAccept
        token="secret-invite-token"
        watchlistId="shared-watchlist-1"
        watchlistName="Friday movie night"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Join Friday movie night' }),
    );

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/watchlist/shared-watchlist-1');
    });

    expect(fetch).toHaveBeenCalledWith('/api/watchlist/invite/accept', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: 'secret-invite-token' }),
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('shows an already-joined message when the invite is accepted again', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        joined: false,
        watchlist: {
          id: 'shared-watchlist-1',
          name: 'Friday movie night',
        },
      }),
    } as Response);

    render(
      <WatchlistInvitePageClient
        canAccept
        token="secret-invite-token"
        watchlistId="shared-watchlist-1"
        watchlistName="Friday movie night"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Join Friday movie night' }),
    );

    await waitFor(() => {
      expect(
        screen.getByText('You already have access to Friday movie night.'),
      ).toBeTruthy();
    });
  });

  it('shows an error when invite acceptance fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'Invite link is invalid or expired.',
      }),
    } as Response);

    render(
      <WatchlistInvitePageClient
        canAccept
        token="expired-token"
        watchlistId="shared-watchlist-1"
        watchlistName="Friday movie night"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Join Friday movie night' }),
    );

    await waitFor(() => {
      expect(screen.getByText('Invite acceptance failed')).toBeTruthy();
    });

    expect(screen.getByText('Invite link is invalid or expired.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('hides the accept button when the invite cannot be used', () => {
    render(
      <WatchlistInvitePageClient
        canAccept={false}
        token="invalid-token"
        watchlistId={null}
        watchlistName={null}
      />,
    );

    expect(screen.getByText('Invite unavailable')).toBeTruthy();
    expect(
      screen.getByText(
        'This invite cannot be used. It may have expired, been rotated, or never existed.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Join/ })).toBeNull();
  });
});
