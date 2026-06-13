import { describe, expect, it } from 'vitest';

import {
  formatReleaseDate,
  getResultCountLabel,
  getSearchHref,
  getWatchlistSignInHref,
  getWatchlistStatusMessage,
} from '../src/app/search/search-page-client';

describe('search page helpers', () => {
  it('formats known release dates for result cards', () => {
    expect(formatReleaseDate('1999-03-31')).toBe('Mar 31, 1999');
  });

  it('falls back when a release date is missing or invalid', () => {
    expect(formatReleaseDate(null)).toBe('Release date TBD');
    expect(formatReleaseDate('not-a-date')).toBe('Release date TBD');
  });

  it('builds a clean search href from trimmed user input', () => {
    expect(getSearchHref('/search', '  fight club  ')).toBe('/search?q=fight%20club');
    expect(getSearchHref('/search', '   ')).toBe('/search');
  });

  it('builds a sign-in link that returns to the current search', () => {
    expect(getWatchlistSignInHref('/search', 'fight club')).toBe(
      '/sign-in?next=%2Fsearch%3Fq%3Dfight%2520club',
    );
  });

  it('renders result count labels for singular and plural result sets', () => {
    expect(getResultCountLabel(1)).toBe('1 match');
    expect(getResultCountLabel(2)).toBe('2 matches');
  });

  it('describes watchlist save states without exposing implementation details', () => {
    expect(getWatchlistStatusMessage('idle')).toBe(
      'Add this result to your private watchlist.',
    );
    expect(getWatchlistStatusMessage('saved')).toBe(
      'The authenticated add flow succeeded for this movie.',
    );
    expect(getWatchlistStatusMessage('error')).toBe(
      'Could not add this movie right now.',
    );
  });
});
