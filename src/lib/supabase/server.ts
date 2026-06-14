import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './database';
import { getPublicSupabaseEnv, getServerSupabaseEnv } from './env';

export type ServerSupabaseClient = SupabaseClient<Database>;

const serverClientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
};

function assertServerRuntime(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'Server Supabase helpers cannot run in the browser. Import the browser helper instead.',
    );
  }
}

function createConfiguredServerSupabaseClient(
  key: string,
  accessToken?: string,
): ServerSupabaseClient {
  const { url } = getPublicSupabaseEnv();

  return createClient<Database>(url, key, {
    ...serverClientOptions,
    global: accessToken
      ? {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      : undefined,
  });
}

export function createServerSupabaseClient(
  accessToken?: string,
): ServerSupabaseClient {
  assertServerRuntime();

  const { anonKey } = getPublicSupabaseEnv();

  return createConfiguredServerSupabaseClient(anonKey, accessToken);
}

export function createServerSupabaseServiceRoleClient(): ServerSupabaseClient {
  assertServerRuntime();

  const { serviceRoleKey } = getServerSupabaseEnv();

  return createConfiguredServerSupabaseClient(serviceRoleKey);
}
