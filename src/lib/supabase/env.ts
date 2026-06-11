const PLACEHOLDER_ENV_VALUES = new Set([
  'https://your-project-ref.supabase.co',
  'your-supabase-anon-key',
  'your-supabase-service-role-key',
]);

const DISPOSABLE_CREDENTIALS_MESSAGE =
  'Replace placeholder values with disposable or dev-only Supabase credentials before using Supabase helpers.';

export class SupabaseEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseEnvironmentError';
  }
}

export interface PublicSupabaseEnv {
  url: string;
  anonKey: string;
}

export interface ServerSupabaseEnv extends PublicSupabaseEnv {
  serviceRoleKey: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new SupabaseEnvironmentError(
      `Missing required environment variable ${name}. ${DISPOSABLE_CREDENTIALS_MESSAGE}`,
    );
  }

  if (PLACEHOLDER_ENV_VALUES.has(value)) {
    throw new SupabaseEnvironmentError(
      `Environment variable ${name} is still using a placeholder value. ${DISPOSABLE_CREDENTIALS_MESSAGE}`,
    );
  }

  return value;
}

function readSupabaseUrl(): string {
  const value = readRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');

  try {
    const url = new URL(value);

    if (!/^https?:$/.test(url.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new SupabaseEnvironmentError(
      'NEXT_PUBLIC_SUPABASE_URL must be a valid http(s) URL.',
    );
  }

  return value;
}

export function getPublicSupabaseEnv(): PublicSupabaseEnv {
  return {
    url: readSupabaseUrl(),
    anonKey: readRequiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  };
}

export function getServerSupabaseEnv(): ServerSupabaseEnv {
  const publicEnv = getPublicSupabaseEnv();

  return {
    ...publicEnv,
    serviceRoleKey: readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  };
}
