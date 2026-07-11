import { describe, expect, it, vi } from 'vitest';

import { throwSupabaseError } from '../src/lib/supabase/watchlist/shared';
import { WatchlistDataError } from '../src/lib/watchlist';

describe('throwSupabaseError', () => {
  it('throws a WatchlistDataError', () => {
    expect(() => throwSupabaseError(null)).toThrow(WatchlistDataError);
  });

  it('throws with the expected message', () => {
    expect(() => throwSupabaseError(null)).toThrow('Supabase request failed.');
  });

  it('logs the error before throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = {
      code: 'P0001',
      message: 'test error',
      details: '',
      hint: '',
      name: 'PostgrestError',
    };

    expect(() => throwSupabaseError(error)).toThrow(WatchlistDataError);
    expect(spy).toHaveBeenCalledWith(
      '[watchlist] Supabase request failed',
      error,
    );

    spy.mockRestore();
  });
});
