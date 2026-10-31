import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatReleaseDate } from '../src/lib/format-release-date';

describe('formatReleaseDate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['1999-03-31', 'Mar 31, 1999'],
    ['2027-03-05', 'Mar 5, 2027'],
    ['2026-12-31', 'Dec 31, 2026'],
    ['2027-01-01', 'Jan 1, 2027'],
    ['2024-02-29', 'Feb 29, 2024'],
    ['2000-02-29', 'Feb 29, 2000'],
  ])('formats %s as %s', (releaseDate, expected) => {
    expect(formatReleaseDate(releaseDate)).toBe(expected);
  });

  it.each([
    '2025-02-29',
    '1900-02-29',
    '2100-02-29',
    '2025-02-30',
    '2025-13-01',
    '2025-00-01',
    '2025-01-00',
    '2025-01-32',
    '2025-04-31',
  ])('rejects impossible date %s instead of normalizing it', (releaseDate) => {
    expect(formatReleaseDate(releaseDate)).toBe('Release date TBA');
  });

  it.each([
    'not-a-date',
    '2025-2-3',
    '2025/02/03',
    '2025-02-03T00:00:00Z',
    '2025-02',
    ' 2025-02-03',
    '2025-02-03 ',
  ])('rejects noncanonical string %s', (releaseDate) => {
    expect(formatReleaseDate(releaseDate)).toBe('Release date TBA');
  });

  it.each([null, undefined, '', ' '])('falls back to TBA for %s', (releaseDate) => {
    expect(formatReleaseDate(releaseDate)).toBe('Release date TBA');
  });

  it.each(['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])(
    'preserves calendar dates in timezone %s',
    (timeZone) => {
      vi.stubEnv('TZ', timeZone);

      expect(formatReleaseDate('2026-12-31')).toBe('Dec 31, 2026');
      expect(formatReleaseDate('2027-01-01')).toBe('Jan 1, 2027');
      expect(formatReleaseDate('2024-02-29')).toBe('Feb 29, 2024');
    },
  );

  it('uses English month names regardless of the environment locale', () => {
    vi.stubEnv('LANG', 'fr_FR.UTF-8');
    vi.stubEnv('LC_ALL', 'fr_FR.UTF-8');

    expect(formatReleaseDate('2027-03-05')).toBe('Mar 5, 2027');
  });
});
