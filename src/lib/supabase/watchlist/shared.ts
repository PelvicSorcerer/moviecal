import type { PostgrestError } from '@supabase/supabase-js';

import { WatchlistDataError } from '../../watchlist';

export const watchlistSelect = `
  id,
  owner_user_id,
  kind,
  name
`;

export const watchlistItemSelect = `
  id,
  added_at,
  movie:movies!watchlist_items_movie_id_fkey (
    id,
    tmdb_id,
    title,
    release_date,
    raw_json,
    updated_at
  )
`;

export const trackedMovieSelect = `
  movie:movies!watchlist_items_movie_id_fkey (
    id,
    tmdb_id,
    title,
    release_date,
    raw_json,
    updated_at
  )
`;

export const watchlistMembershipSelect = `
  id,
  watchlist_id,
  user_id,
  role,
  invited_by_user_id,
  accepted_at
`;

export const watchlistInviteLinkSelect = `
  id,
  watchlist_id,
  created_by_user_id,
  token_hash,
  created_at,
  expires_at,
  revoked_at
`;

export function throwSupabaseError(error: PostgrestError | null): never {
  console.error('[watchlist] Supabase request failed', error);
  throw new WatchlistDataError('Supabase request failed.');
}
