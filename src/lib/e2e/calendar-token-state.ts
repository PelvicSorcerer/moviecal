import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CookieValueReader } from '../auth/cookies';
import {
  createNextE2ECalendarToken,
  readE2ECalendarToken,
} from './fixtures';

const E2E_CALENDAR_TOKEN_STATE_PATH = join(
  tmpdir(),
  'moviecal-e2e-calendar-token.txt',
);

function readActiveE2ECalendarTokens(): Set<string> {
  if (!existsSync(E2E_CALENDAR_TOKEN_STATE_PATH)) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(
      readFileSync(E2E_CALENDAR_TOKEN_STATE_PATH, 'utf8'),
    ) as unknown;

    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeActiveE2ECalendarTokens(tokens: Set<string>): void {
  writeFileSync(
    E2E_CALENDAR_TOKEN_STATE_PATH,
    JSON.stringify([...tokens]),
    'utf8',
  );
}

function addActiveE2ECalendarToken(token: string): string {
  const tokens = readActiveE2ECalendarTokens();
  tokens.add(token);
  writeActiveE2ECalendarTokens(tokens);

  return token;
}

export function isE2ECalendarTokenActive(token: string): boolean {
  return readActiveE2ECalendarTokens().has(token);
}

export function syncE2ECalendarToken(reader: CookieValueReader): string {
  return addActiveE2ECalendarToken(readE2ECalendarToken(reader));
}

export function rotateE2ECalendarToken(reader: CookieValueReader): string {
  const currentToken = readE2ECalendarToken(reader);
  const nextToken = createNextE2ECalendarToken(currentToken);
  const tokens = readActiveE2ECalendarTokens();

  tokens.delete(currentToken);
  tokens.add(nextToken);
  writeActiveE2ECalendarTokens(tokens);

  return nextToken;
}

export function clearE2ECalendarToken(reader: CookieValueReader): void {
  const currentToken = readE2ECalendarToken(reader);
  const tokens = readActiveE2ECalendarTokens();

  tokens.delete(currentToken);
  writeActiveE2ECalendarTokens(tokens);
}

export function resetE2ECalendarToken(): void {
  writeActiveE2ECalendarTokens(new Set());
}
