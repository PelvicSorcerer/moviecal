import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { createClient } from '@supabase/supabase-js';

const require = createRequire(import.meta.url);
const playwrightCliPath = require.resolve('@playwright/test/cli');

const PLACEHOLDER_ENV_VALUES = new Set([
  'https://your-project-ref.supabase.co',
  'your-supabase-anon-key',
  'your-supabase-service-role-key',
]);

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  if (PLACEHOLDER_ENV_VALUES.has(value)) {
    throw new Error(`Environment variable ${name} is still using a placeholder value.`);
  }

  return value;
}

function createRuntimeDescriptor() {
  const runToken = randomUUID().replaceAll('-', '');
  const movieSuffix = Number.parseInt(runToken.slice(0, 6), 16);
  const movieTmdbId = 90_000_000 + movieSuffix;

  return {
    calendarToken: `moviecal-ci-calendar-token-${runToken}-seeded-1234567890`,
    email: `ci-full-stack-${runToken.slice(0, 12)}@moviecal.test`,
    movie: {
      overview:
        'Disposable Supabase-backed watchlist fixture for the full-stack runtime lane.',
      rawJson: {
        overview:
          'Disposable Supabase-backed watchlist fixture for the full-stack runtime lane.',
        poster_path: '/ci-full-stack-seeded-poster.jpg',
      },
      releaseDate: '2026-12-18',
      title: 'Disposable CI Seed Movie',
      tmdbId: movieTmdbId,
    },
    password: `Moviecal-${runToken.slice(0, 18)}-Aa1!`,
  };
}

function assertResponse(data, error, context) {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }

  if (!data) {
    throw new Error(`${context}: missing response data.`);
  }

  return data;
}

async function seedRuntime(adminClient, runtime, seededState) {
  const userResponse = await adminClient.auth.admin.createUser({
    email: runtime.email,
    email_confirm: true,
    password: runtime.password,
  });
  const user = assertResponse(
    userResponse.data.user,
    userResponse.error,
    'Could not create disposable Supabase user',
  );
  seededState.userId = user.id;

  const watchlistResponse = await adminClient
    .from('watchlists')
    .insert({ owner_user_id: user.id, kind: 'personal', name: 'My watchlist' })
    .select('id')
    .single();
  const watchlistId = assertResponse(
    watchlistResponse.data?.id,
    watchlistResponse.error,
    'Could not create the seeded personal watchlist',
  );
  seededState.watchlistId = watchlistId;

  const movieResponse = await adminClient
    .from('movies')
    .upsert(
      {
        raw_json: runtime.movie.rawJson,
        release_date: runtime.movie.releaseDate,
        title: runtime.movie.title,
        tmdb_id: runtime.movie.tmdbId,
      },
      { onConflict: 'tmdb_id' },
    )
    .select('id')
    .single();
  const movie = assertResponse(
    movieResponse.data,
    movieResponse.error,
    'Could not upsert the seeded movie row',
  );
  seededState.movieId = movie.id;

  const watchlistItemResponse = await adminClient
    .from('watchlist_items')
    .upsert(
      {
        movie_id: movie.id,
        watchlist_id: watchlistId,
      },
      { onConflict: 'watchlist_id,movie_id' },
    )
    .select('id')
    .single();
  const watchlistItem = assertResponse(
    watchlistItemResponse.data,
    watchlistItemResponse.error,
    'Could not seed the watchlist item',
  );
  seededState.itemId = watchlistItem.id;

  const calendarTokenResponse = await adminClient
    .from('calendar_tokens')
    .upsert(
      {
        token: runtime.calendarToken,
        user_id: user.id,
      },
      { onConflict: 'user_id' },
    )
    .select('id')
    .single();
  assertResponse(
    calendarTokenResponse.data,
    calendarTokenResponse.error,
    'Could not seed the calendar token',
  );
}

async function cleanupRuntime(adminClient, runtime, seededState) {
  const cleanupErrors = [];

  if (seededState.userId) {
    const deleteUserResponse = await adminClient.auth.admin.deleteUser(seededState.userId);

    if (deleteUserResponse.error) {
      cleanupErrors.push(
        `Could not delete disposable Supabase user: ${deleteUserResponse.error.message}`,
      );
    }
  }

  const deleteMovieResponse = await adminClient
    .from('movies')
    .delete()
    .eq('tmdb_id', runtime.movie.tmdbId);

  if (deleteMovieResponse.error) {
    cleanupErrors.push(
      `Could not delete the seeded movie row: ${deleteMovieResponse.error.message}`,
    );
  }

  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join(' | '));
  }
}

async function runPlaywright(runtime) {
  const env = {
    ...process.env,
    MOVIECAL_FULL_STACK_MOVIE_TITLE: runtime.movie.title,
    MOVIECAL_FULL_STACK_USER_EMAIL: runtime.email,
    MOVIECAL_FULL_STACK_USER_PASSWORD: runtime.password,
  };

  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [playwrightCliPath, 'test', '--config', 'playwright.full-stack.config.ts'],
      {
        env,
        stdio: 'inherit',
      },
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Playwright exited from signal ${signal}.`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function main() {
  const supabaseUrl = readRequiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  readRequiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  const runtime = createRuntimeDescriptor();
  const seededState = {
    itemId: '',
    movieId: 0,
    userId: '',
    watchlistId: '',
  };

  let playwrightExitCode = 1;
  let cleanupError = null;

  try {
    await seedRuntime(adminClient, runtime, seededState);
    playwrightExitCode = await runPlaywright(runtime);
  } finally {
    try {
      await cleanupRuntime(adminClient, runtime, seededState);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (cleanupError instanceof Error) {
    throw cleanupError;
  }

  process.exit(playwrightExitCode);
}

await main();
