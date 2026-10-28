// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import PageLoading from '../src/app/page-loading';
import SearchLoading from '../src/app/search/loading';

afterEach(cleanup);

describe('PageLoading', () => {
  it.each([
    ['search', 'Loading search…'],
    ['watchlists', 'Loading watchlists…'],
    ['watchlist', 'Loading watchlist…'],
  ] as const)('announces the %s page with a visually hidden status label', (page, label) => {
    render(<PageLoading page={page} />);

    const status = screen.getByRole('status');
    const statusLabel = within(status).getByText(label);
    expect(statusLabel.className).toContain('srOnly');
    expect(status.closest('[aria-busy="true"]')).not.toBeNull();
    expect(status.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('hides decorative placeholders from assistive technology', () => {
    const { container } = render(<PageLoading page="search" />);

    const decoration = container.querySelector('[aria-hidden="true"]');
    expect(decoration).not.toBeNull();
    expect(decoration?.contains(screen.getByText('Movie search'))).toBe(true);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('wires the search route fallback to its own announcement', () => {
    render(<SearchLoading />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Loading search…');
  });
});
