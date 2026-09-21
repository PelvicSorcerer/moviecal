import { describe, expect, it } from 'vitest';

import { formatReleaseDate } from '../src/lib/format-release-date';

describe('formatReleaseDate', () => {
  it('formats valid canonical release dates', () => {
    expect(formatReleaseDate('1999-03-31')).toBe('Mar 31, 1999');
    expect(formatReleaseDate('2025-01-01')).toBe('Jan 1, 2025');
  });

  it('formats a valid leap-day date', () => {
    expect(formatReleaseDate('2024-02-29')).toBe('Feb 29, 2024');
  });

  it('rejects impossible dates instead of normalizing them', () => {
    expect(formatReleaseDate('2025-02-29')).toBe('Release date TBD');
    expect(formatReleaseDate('2025-02-30')).toBe('Release date TBD');
    expect(formatReleaseDate('2025-13-01')).toBe('Release date TBD');
    expect(formatReleaseDate('2025-04-31')).toBe('Release date TBD');
  });

  it('rejects noncanonical date strings', () => {
    expect(formatReleaseDate('not-a-date')).toBe('Release date TBD');
    expect(formatReleaseDate('2025-2-3')).toBe('Release date TBD');
    expect(formatReleaseDate('2025/02/03')).toBe('Release date TBD');
    expect(formatReleaseDate('2025-02-03T00:00:00Z')).toBe('Release date TBD');
  });

  it('falls back to TBD for null input', () => {
    expect(formatReleaseDate(null)).toBe('Release date TBD');
  });
});
