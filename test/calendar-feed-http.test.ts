import { describe, expect, it } from 'vitest';

import {
  buildCalendarFeedEtag,
  matchesCalendarFeedEtag,
} from '../src/lib/calendar-feed-http';

describe('calendar feed validators', () => {
  it('returns a quoted SHA-256 digest of the exact body', () => {
    expect(buildCalendarFeedEtag('abc')).toBe(
      '"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"',
    );
    expect(buildCalendarFeedEtag('abc')).toBe(buildCalendarFeedEtag('abc'));
    expect(buildCalendarFeedEtag('abc\r\n')).not.toBe(buildCalendarFeedEtag('abc'));
    expect(buildCalendarFeedEtag('é')).not.toBe(buildCalendarFeedEtag('e'));
  });

  it.each([
    ['"digest"', true],
    ['W/"digest"', true],
    [' "other", W/"digest" , "last" ', true],
    ['*', true],
    [' * ', true],
    [null, false],
    ['', false],
    ['"other"', false],
    ['digest', false],
    ['"DIGEST"', false],
    ['w/"digest"', false],
    ['"prefix,digest"', false],
  ])('compares %s using weak GET comparison', (header, matches) => {
    expect(matchesCalendarFeedEtag(header, '"digest"')).toBe(matches);
  });
});
