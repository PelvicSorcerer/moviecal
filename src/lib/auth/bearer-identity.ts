import type { User } from '@supabase/supabase-js';

import {
  createServerSupabaseClient,
  type ServerSupabaseClient,
} from '../supabase/server';

import { extractBearerToken } from './bearer';
import { resolveAuthTokensWithClient } from './identity';


export interface BearerIdentity {
    userClient: ServerSupabaseClient;
  user: User;
}

export async function resolveBearerIdentity(
  request: Request,
): Promise<BearerIdentity | null> {
  const token = extractBearerToken(request);

  if (!token) {
    return null;
  }

  const userClient = createServerSupabaseClient(token);
  const auth = await resolveAuthTokensWithClient(
    userClient,
    // Bearer-only auth: the Authorization header carries no refresh token, so
    // there is nothing to refresh. `refreshToken` is empty and, with
    // `allowRefresh: false`, the refresh branch never runs and never reads it.
    { accessToken: token, refreshToken: '' },
    { allowRefresh: false },
  );

  if (!auth.user) {
    return null;
  }

  return { user: auth.user, userClient };
}
