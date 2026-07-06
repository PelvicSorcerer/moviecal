import { describe, expect, it } from 'vitest';

import {
  buildCalendarEventUid,
  buildCalendarFeed,
  escapeCalendarText,
  foldCalendarLine,
  formatCalendarDate,
  formatCalendarTimestamp,
} from '../src/lib/calendar-feed';
import { TEST_TMDB_IDS, TEST_USER_IDS } from '../src/lib/test-data/catalog';
import { buildWatchlistItem } from './support';

describe('calendar feed helpers', () => {
  it('formats all-day calendar dates as YYYYMMDD', () => {
    expect(formatCalendarDate('1999-03-31')).toBe('19990331');
    expect(formatCalendarDate('1999-02-29')).toBeNull();
    expect(formatCalendarDate(null)).toBeNull();
  });

  it('formats UTC timestamps for DTSTAMP fields', () => {
    expect(formatCalendarTimestamp(new Date('2026-06-20T14:05:06.789Z'))).toBe(
      '20260620T140506Z',
    );
  });

  it('builds stable user/movie scoped UIDs', () => {
    expect(buildCalendarEventUid('user-1', 603)).toBe(
      '35c9675c92fcbee5a2b50e3bf7bcc6797211309f5f0513b0f6f8aa66030a959b@moviecal',
    );
    expect(buildCalendarEventUid(TEST_USER_IDS.OWNER, TEST_TMDB_IDS.MATRIX)).toBe(
      buildCalendarEventUid('user-1', 603),
    );
    expect(buildCalendarEventUid('user-2', 603)).not.toBe(
      buildCalendarEventUid('user-1', 603),
    );
  });

  it('escapes special characters for ical text fields', () => {
    expect(escapeCalendarText('Line 1, line 2;\\ok\nNext')).toBe(
      'Line 1\\, line 2\\;\\\\ok\\nNext',
    );
  });

  it('folds long calendar content lines at RFC-compatible widths', () => {
    expect(foldCalendarLine(`SUMMARY:${'A'.repeat(80)}`)).toEqual([
      `SUMMARY:${'A'.repeat(67)}`,
      ` ${'A'.repeat(13)}`,
    ]);
  });
});

describe('buildCalendarFeed', () => {
  it('generates deterministic ics output for dated watchlist items', () => {
    const generatedAt = new Date('2026-06-20T14:05:06.789Z');
    const feed = buildCalendarFeed({
      generatedAt,
      items: [
        buildWatchlistItem({
          movie: {
            ...buildWatchlistItem().movie,
            overview: 'Dream invasion, commas, and semicolons; included.',
            releaseDate: '2010-07-16',
            title: 'Inception, Part I',
            tmdbId: 27205,
          },
        }),
        buildWatchlistItem({
          id: 'watchlist-item-2',
          movie: {
            ...buildWatchlistItem().movie,
            overview: null,
            releaseDate: '1999-03-31',
            title: 'The Matrix',
            tmdbId: 603,
          },
        }),
      ],
      userId: 'user-1',
    });

    expect(feed).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//moviecal//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        ...foldCalendarLine(
          'UID:35c9675c92fcbee5a2b50e3bf7bcc6797211309f5f0513b0f6f8aa66030a959b@moviecal',
        ),
        'DTSTAMP:20260620T140506Z',
        'DTSTART;VALUE=DATE:19990331',
        'SUMMARY:The Matrix',
        'DESCRIPTION:https://www.themoviedb.org/movie/603',
        'STATUS:CONFIRMED',
        'END:VEVENT',
        'BEGIN:VEVENT',
        ...foldCalendarLine(
          'UID:b6718b4bcde592fbbe8fe72fdbedf9f4554bc97d5224c00efe414a59089c166f@moviecal',
        ),
        'DTSTAMP:20260620T140506Z',
        'DTSTART;VALUE=DATE:20100716',
        'SUMMARY:Inception\\, Part I',
        ...foldCalendarLine(
          'DESCRIPTION:https://www.themoviedb.org/movie/27205\\n\\nDream invasion\\, commas\\, and semicolons\\; included.',
        ),
        'STATUS:CONFIRMED',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
  });

  it('folds long property values in generated events', () => {
    const feed = buildCalendarFeed({
      generatedAt: new Date('2026-06-20T14:05:06.789Z'),
      items: [
        buildWatchlistItem({
          movie: {
            ...buildWatchlistItem().movie,
            overview: 'A'.repeat(120),
            title: `Epic ${'B'.repeat(80)}`,
            tmdbId: 700,
          },
        }),
      ],
      userId: 'user-1',
    });

    const lines = feed.split('\r\n').filter(Boolean);

    expect(
      lines.every((line) => Buffer.byteLength(line, 'utf8') <= 75),
    ).toBe(true);
    expect(feed).toContain(
      foldCalendarLine(`SUMMARY:${escapeCalendarText(`Epic ${'B'.repeat(80)}`)}`).join(
        '\r\n',
      ),
    );
    expect(feed).toContain(
      foldCalendarLine(
        `DESCRIPTION:${escapeCalendarText(`https://www.themoviedb.org/movie/700\n\n${'A'.repeat(120)}`)}`,
      ).join('\r\n'),
    );
  });

  it('skips duplicate tmdb ids when defensive feed dedupe receives repeated items', () => {
    const feed = buildCalendarFeed({
      generatedAt: new Date('2026-06-20T14:05:06.789Z'),
      items: [
        buildWatchlistItem(),
        buildWatchlistItem({
          id: 'watchlist-item-duplicate',
          movie: {
            ...buildWatchlistItem().movie,
            title: 'Duplicate Matrix',
          },
        }),
      ],
      userId: 'user-1',
    });

    expect(feed.match(/BEGIN:VEVENT/g)?.length).toBe(1);
    expect(feed).toContain('SUMMARY:The Matrix');
    expect(feed).not.toContain('Duplicate Matrix');
  });

  it('skips movies with missing or invalid release dates', () => {
    const feed = buildCalendarFeed({
      generatedAt: new Date('2026-06-20T14:05:06.789Z'),
      items: [
        buildWatchlistItem({
          movie: {
            ...buildWatchlistItem().movie,
            releaseDate: null,
          },
        }),
        buildWatchlistItem({
          id: 'watchlist-item-2',
          movie: {
            ...buildWatchlistItem().movie,
            releaseDate: '2026-02-30',
            tmdbId: 604,
          },
        }),
      ],
      userId: 'user-1',
    });

    expect(feed).not.toContain('BEGIN:VEVENT');
    expect(feed).toContain('BEGIN:VCALENDAR');
    expect(feed).toContain('END:VCALENDAR');
  });
});
