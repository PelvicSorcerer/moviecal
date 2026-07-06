import type { CalendarTokenRow } from '../../../src/lib/calendar-tokens';
import {
  TEST_CALENDAR_TOKENS,
  TEST_TIMESTAMPS,
  TEST_USER_IDS,
} from '../../../src/lib/test-data/catalog';

export function buildCalendarTokenRow(
  overrides: Partial<CalendarTokenRow> = {},
): CalendarTokenRow {
  return {
    created_at: TEST_TIMESTAMPS.TOKEN_CREATED,
    id: 'token-row-1',
    token: TEST_CALENDAR_TOKENS.DEFAULT,
    user_id: TEST_USER_IDS.OWNER,
    ...overrides,
  };
}

export function buildSeededCalendarToken(seed: string = TEST_CALENDAR_TOKENS.SEED): string {
  return `e2e-calendar-token-${seed}-initial`;
}
