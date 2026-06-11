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

export function createServerSupabaseClient(): ServerSupabaseClient {
  assertServerRuntime();

  const { url, anonKey } = getPublicSupabaseEnv();

  return createClient<Database>(url, anonKey, serverClientOptions);
}

export function createServerSupabaseServiceRoleClient(): ServerSupabaseClient {
  assertServerRuntime();

  const { url, serviceRoleKey } = getServerSupabaseEnv();

  return createClient<Database>(url, serviceRoleKey, serverClientOptions);
}
