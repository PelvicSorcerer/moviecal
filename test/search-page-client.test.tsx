// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SearchPageClient } from '../src/app/search/search-page-client';
import { TEST_TMDB_IDS } from '../src/lib/test-data/catalog';
import {
  buildTmdbSearchResponse,
  buildWatchlistSummary,
} from './support';

vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({
    replace: vi.fn(),
  }),
}));

describe('SearchPageClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the idle state before a search is submitted', () => {
    render(
      <SearchPageClient
        availableWatchlists={[]}
        initialQuery=""
        isAuthenticated={false}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Search the TMDb-backed catalog' }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText('Search by title')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a loading state while the initial query is in flight', () => {
    vi.mocked(fetch).mockImplementation(
      () => new Promise(() => {}),
    );

    render(
      <SearchPageClient
        availableWatchlists={[]}
        initialQuery="matrix"
        isAuthenticated={false}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Searching…' })).toBeTruthy();
    expect(screen.getByText(/Looking up matches for/)).toBeTruthy();
    expect(screen.getByText('matrix')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      '/api/movies/search?q=matrix',
      {
        method: 'GET',
        cache: 'no-store',
      },
    );
  });

  it('renders search results from stable fixtures', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => buildTmdbSearchResponse([TEST_TMDB_IDS.MATRIX]),
    } as Response);

    render(
      <SearchPageClient
        availableWatchlists={[]}
        initialQuery="matrix"
        isAuthenticated={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Search results' })).toBeTruthy();
    });

    expect(screen.getByText('1 match for')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'The Matrix' })).toBeTruthy();
    expect(screen.getByText('Mar 31, 1999')).toBeTruthy();
    expect(screen.getByText('A hacker discovers the truth.')).toBeTruthy();
  });

  it('renders the empty state when no movies match the query', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);

    render(
      <SearchPageClient
        availableWatchlists={[]}
        initialQuery="unknown-title"
        isAuthenticated={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'No matches yet' })).toBeTruthy();
    });

    expect(screen.getByText(/No movies matched/)).toBeTruthy();
    expect(screen.getByText('unknown-title')).toBeTruthy();
  });

  it('surfaces search endpoint failures without crashing', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: 'Movie search is unavailable until TMDb is configured.',
      }),
    } as Response);

    render(
      <SearchPageClient
        availableWatchlists={[]}
        initialQuery="matrix"
        isAuthenticated={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Search unavailable')).toBeTruthy();
    });

    expect(
      screen.getByText('Movie search is unavailable until TMDb is configured.'),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Search results' })).toBeNull();
  });

  it('prompts anonymous visitors to sign in before adding movies', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => buildTmdbSearchResponse([TEST_TMDB_IDS.MATRIX]),
    } as Response);

    render(
      <SearchPageClient
        availableWatchlists={[]}
        initialQuery="matrix"
        isAuthenticated={false}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: 'Sign in to add movies to your watchlist' }),
      ).toBeTruthy();
    });

    expect(
      screen.getByText('Sign in to save this movie to your private watchlist.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to watchlist' })).toBeNull();
  });

  it('only offers editable watchlists as add targets', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => buildTmdbSearchResponse([TEST_TMDB_IDS.MATRIX]),
    } as Response);

    render(
      <SearchPageClient
        availableWatchlists={[
          buildWatchlistSummary(),
          buildWatchlistSummary({
            canEdit: false,
            id: 'shared-watchlist-readonly',
            kind: 'shared',
            name: 'Curated picks',
          }),
        ]}
        initialQuery="matrix"
        isAuthenticated
      />,
    );

    await waitFor(() => {
      const saveTo = screen.getByLabelText('Save to') as HTMLSelectElement;

      expect(saveTo.value).toBe('personal-watchlist-1');
      expect(screen.getByRole('option', { name: 'My watchlist' })).toBeTruthy();
      expect(screen.queryByRole('option', { name: 'Curated picks' })).toBeNull();
      expect(screen.getByText('Read-only watchlists: Curated picks.')).toBeTruthy();
    });
  });

  it('surfaces a read-only message when no accessible watchlists allow edits', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => buildTmdbSearchResponse([TEST_TMDB_IDS.MATRIX]),
    } as Response);

    render(
      <SearchPageClient
        availableWatchlists={[
          buildWatchlistSummary({
            canEdit: false,
            id: 'shared-watchlist-readonly',
            kind: 'shared',
            name: 'Curated picks',
          }),
        ]}
        initialQuery="matrix"
        isAuthenticated
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          'You can view shared watchlists, but none of your current targets allow edits.',
        ),
      ).toBeTruthy();
      expect(screen.queryByLabelText('Save to')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add to watchlist' })).toBeNull();
      expect(
        screen.getByText(
          'Your current watchlist memberships are read-only, so you cannot add this movie from search.',
        ),
      ).toBeTruthy();
    });
  });

  it('marks a result as added after a successful watchlist mutation', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => buildTmdbSearchResponse([TEST_TMDB_IDS.MATRIX]),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          created: true,
          watchlist: buildWatchlistSummary(),
        }),
      } as Response);

    render(
      <SearchPageClient
        availableWatchlists={[buildWatchlistSummary()]}
        initialQuery="matrix"
        isAuthenticated
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add to watchlist' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Added' })).toBeTruthy();
    });

    expect(screen.getByText('Saved to My watchlist.')).toBeTruthy();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/watchlist',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tmdb_id: TEST_TMDB_IDS.MATRIX,
          watchlist_id: 'personal-watchlist-1',
        }),
      },
    );
  });

  it('keeps the result visible and shows an error when watchlist add fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => buildTmdbSearchResponse([TEST_TMDB_IDS.MATRIX]),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: 'Watchlist access denied.',
        }),
      } as Response);

    render(
      <SearchPageClient
        availableWatchlists={[buildWatchlistSummary()]}
        initialQuery="matrix"
        isAuthenticated
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add to watchlist' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));

    await waitFor(() => {
      expect(screen.getByText('Could not add this movie right now.')).toBeTruthy();
    });

    expect(screen.getByRole('heading', { name: 'The Matrix' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to watchlist' })).toBeTruthy();
  });

  it('updates the search input as the visitor types', () => {
    render(
      <SearchPageClient
        availableWatchlists={[]}
        initialQuery=""
        isAuthenticated={false}
      />,
    );

    const searchInput = screen.getByPlaceholderText('Search by title') as HTMLInputElement;

    fireEvent.change(searchInput, {
      target: { value: '  inception  ' },
    });

    expect(searchInput.value).toBe('  inception  ');
  });
});
