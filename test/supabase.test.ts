import { afterEach, describe, expect, it } from 'vitest';

import {
  getPublicSupabaseEnv,
  getServerSupabaseEnv,
  SupabaseEnvironmentError,
} from '../src/lib/supabase/env';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../src/lib/supabase/server';
import { createBrowserSupabaseClient } from '../src/lib/supabase/browser';

const originalEnv = { ...process.env };

function setValidSupabaseEnv(): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://moviecal-dev.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-tests';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-tests';
}

afterEach(() => {
  process.env = { ...originalEnv };
  delete (globalThis as { window?: unknown }).window;
});

describe('Supabase environment validation', () => {
  it('reads the public browser-safe environment values', () => {
    setValidSupabaseEnv();

    expect(getPublicSupabaseEnv()).toEqual({
      url: 'https://moviecal-dev.supabase.co',
      anonKey: 'anon-key-for-tests',
    });
  });

  it('rejects placeholder public values', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://your-project-ref.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'your-supabase-anon-key';

    expect(() => getPublicSupabaseEnv()).toThrowError(SupabaseEnvironmentError);
    expect(() => getPublicSupabaseEnv()).toThrowError(/placeholder value/);
  });

  it('requires the server-only service role key for admin helpers', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://moviecal-dev.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-tests';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => getServerSupabaseEnv()).toThrowError(SupabaseEnvironmentError);
    expect(() => getServerSupabaseEnv()).toThrowError(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe('Supabase client helpers', () => {
  it('creates server clients when the required env is present', () => {
    setValidSupabaseEnv();

    const serverClient = createServerSupabaseClient();
    const adminClient = createServerSupabaseServiceRoleClient();

    expect(serverClient.auth).toBeDefined();
    expect(adminClient.auth).toBeDefined();
  });

  it('creates the browser client without reading the service-role key', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://moviecal-dev.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-tests';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    (globalThis as { window?: unknown }).window = {};

    const browserClient = createBrowserSupabaseClient();

    expect(browserClient.auth).toBeDefined();
  });
});
