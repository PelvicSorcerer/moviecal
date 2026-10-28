// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { getMoviePosterUrl, MoviePoster } from '../src/app/movie-poster';

afterEach(cleanup);

describe('MoviePoster', () => {
  it('builds a small TMDb poster URL and handles absent paths', () => {
    expect(getMoviePosterUrl('/matrix.jpg')).toBe('https://image.tmdb.org/t/p/w154/matrix.jpg');
    expect(getMoviePosterUrl(null)).toBeNull();
  });

  it('renders a lazy image with the title as alt text and reserved dimensions', () => {
    render(<MoviePoster posterPath="/matrix.jpg" title="The Matrix" />);

    const poster = screen.getByRole('img', { name: 'The Matrix' });
    expect(poster.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w154/matrix.jpg');
    expect(poster.getAttribute('loading')).toBe('lazy');
    expect(poster.getAttribute('width')).toBe('64');
    expect(poster.getAttribute('height')).toBe('96');
    expect(poster.className).toContain('h-24 w-16 shrink-0');
  });

  it('reserves the same space without requesting an image for missing posters', () => {
    const { container } = render(<MoviePoster posterPath={null} title="Inception" />);

    const placeholder = screen.getByRole('img', { name: 'No poster available for Inception' });
    expect(placeholder.textContent).toBe('No poster');
    expect(placeholder.className).toContain('h-24 w-16 shrink-0');
    expect(container.querySelector('img')).toBeNull();
  });
});
