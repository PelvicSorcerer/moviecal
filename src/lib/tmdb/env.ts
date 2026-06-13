const PLACEHOLDER_ENV_VALUES = new Set(['your-tmdb-api-key']);

const DISPOSABLE_CREDENTIALS_MESSAGE =
  'Replace placeholder values with a disposable or dev-only TMDb API key before using TMDb helpers.';

export class TMDbEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TMDbEnvironmentError';
  }
}

export interface ServerTMDbEnv {
  apiKey: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new TMDbEnvironmentError(
      `Missing required environment variable ${name}. ${DISPOSABLE_CREDENTIALS_MESSAGE}`,
    );
  }

  if (PLACEHOLDER_ENV_VALUES.has(value)) {
    throw new TMDbEnvironmentError(
      `Environment variable ${name} is still using a placeholder value. ${DISPOSABLE_CREDENTIALS_MESSAGE}`,
    );
  }

  return value;
}

export function getServerTMDbEnv(): ServerTMDbEnv {
  return {
    apiKey: readRequiredEnv('TMDB_API_KEY'),
  };
}
