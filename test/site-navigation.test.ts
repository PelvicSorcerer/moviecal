import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import SiteNavigation from '../src/app/site-navigation';

const mocks = vi.hoisted(() => ({ usePathname: vi.fn() }));

vi.mock('next/navigation', () => ({ usePathname: mocks.usePathname }));

describe('site navigation', () => {
  beforeEach(() => {
    mocks.usePathname.mockReset();
  });

  it.each([
    ['/', 'Home'],
    ['/search', 'Search'],
    ['/watchlist', 'Watchlists'],
    ['/watchlist/shared-list', 'Watchlists'],
    ['/settings/calendar', 'Calendar'],
  ])('marks only the current section for %s', (pathname, label) => {
    mocks.usePathname.mockReturnValue(pathname);

    const markup = renderToStaticMarkup(createElement(SiteNavigation));

    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(new RegExp(`<a[^>]*aria-current="page"[^>]*>${label}</a>`));
  });

  it.each(['/sign-in', '/watchlist-other', '/searching', '/settings'])(
    'does not mark an unrelated route for %s',
    (pathname) => {
      mocks.usePathname.mockReturnValue(pathname);

      expect(renderToStaticMarkup(createElement(SiteNavigation))).not.toContain('aria-current');
    },
  );
});
