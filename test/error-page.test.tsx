// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ErrorPage from '../src/app/error';

afterEach(cleanup);

describe('ErrorPage', () => {
  it('renders branded help with one logical heading', () => {
    render(<ErrorPage error={new Error('Render failed')} reset={vi.fn()} />);

    expect(screen.getByText('moviecal')).toBeDefined();
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Something went wrong');
    expect(screen.getByRole('region', { name: 'Something went wrong' })).toBeDefined();
    expect(screen.getByText('Try again, or head Home to plan your next movie night.')).toBeDefined();
  });

  it('calls reset only when Try again is activated', () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error('Render failed')} reset={reset} />);

    expect(reset).not.toHaveBeenCalled();
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry.getAttribute('type')).toBe('button');
    fireEvent.click(retry);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('provides a Home link and natively focusable recovery controls', () => {
    render(<ErrorPage error={new Error('Render failed')} reset={vi.fn()} />);

    const retry = screen.getByRole('button', { name: 'Try again' });
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home.getAttribute('href')).toBe('/');
    expect(retry.tabIndex).toBe(0);
    expect(home.tabIndex).toBe(0);
    retry.focus();
    expect(document.activeElement).toBe(retry);
    home.focus();
    expect(document.activeElement).toBe(home);
  });

  it('never includes the raw error, stack, or digest in the rendered markup', () => {
    const error = Object.assign(new Error('Private upstream failure details'), {
      stack: 'Error: Private upstream failure details\n at secretServerFunction (private.ts:42)',
      digest: 'private-error-digest',
    });
    const { container } = render(<ErrorPage error={error} reset={vi.fn()} />);

    expect(container.innerHTML).not.toContain(error.message);
    expect(container.innerHTML).not.toContain('secretServerFunction');
    expect(container.innerHTML).not.toContain(error.digest);
  });
});
