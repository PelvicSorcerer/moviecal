import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './database';
import { getPublicSupabaseEnv } from './env';

export type BrowserSupabaseClient = SupabaseClient<Database>;

function assertBrowserRuntime(): void {
  if (typeof window === 'undefined') {
    throw new Error(
      'createBrowserSupabaseClient must be called from a browser runtime. Use the server helper for server code.',
    );
  }
}

export function createBrowserSupabaseClient(): BrowserSupabaseClient {
  assertBrowserRuntime();

  const { url, anonKey } = getPublicSupabaseEnv();

  return createClient<Database>(url, anonKey);
}
