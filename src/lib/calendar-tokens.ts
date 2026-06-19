import { randomBytes } from 'node:crypto';

export interface CalendarTokenRow {
  created_at: string;
  id: string;
  token: string;
  user_id: string;
}

export interface CalendarTokenRepository {
  findTokenByUserId(userId: string): Promise<CalendarTokenRow | null>;
  findUserIdByToken(token: string): Promise<string | null>;
  insertTokenForUser(
    userId: string,
    token: string,
  ): Promise<{ errorCode: string | null; row: CalendarTokenRow | null }>;
  updateTokenForUser(
    userId: string,
    token: string,
  ): Promise<{ errorCode: string | null; row: CalendarTokenRow | null }>;
}

export class CalendarTokenDataError extends Error {
  readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = 'CalendarTokenDataError';
  }
}

export function generateCalendarToken(
  randomBytesImpl: typeof randomBytes = randomBytes,
): string {
  return randomBytesImpl(32).toString('base64url');
}

export function buildCalendarSubscriptionUrl(
  origin: string,
  token: string,
): string {
  return new URL(`/api/calendar/${encodeURIComponent(token)}`, origin).toString();
}

export async function getOrCreateCalendarToken(args: {
  repository: CalendarTokenRepository;
  userId: string;
}): Promise<CalendarTokenRow> {
  const existingRow = await args.repository.findTokenByUserId(args.userId);

  if (existingRow) {
    return existingRow;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const insertResult = await args.repository.insertTokenForUser(
      args.userId,
      generateCalendarToken(),
    );

    if (insertResult.row) {
      return insertResult.row;
    }

    if (insertResult.errorCode === '23505') {
      const racedRow = await args.repository.findTokenByUserId(args.userId);

      if (racedRow) {
        return racedRow;
      }

      continue;
    }

    throw new CalendarTokenDataError('Could not create calendar token.');
  }

  throw new CalendarTokenDataError('Could not create calendar token.');
}

export async function rotateCalendarToken(args: {
  repository: CalendarTokenRepository;
  userId: string;
}): Promise<CalendarTokenRow> {
  const existingRow = await args.repository.findTokenByUserId(args.userId);

  if (!existingRow) {
    return getOrCreateCalendarToken(args);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const updateResult = await args.repository.updateTokenForUser(
      args.userId,
      generateCalendarToken(),
    );

    if (updateResult.row) {
      return updateResult.row;
    }

    if (updateResult.errorCode === '23505') {
      continue;
    }

    throw new CalendarTokenDataError('Could not rotate calendar token.');
  }

  throw new CalendarTokenDataError('Could not rotate calendar token.');
}

export async function resolveCalendarTokenOwner(args: {
  repository: CalendarTokenRepository;
  token: string;
}): Promise<string | null> {
  const token = args.token.trim();

  if (!token) {
    return null;
  }

  return args.repository.findUserIdByToken(token);
}
