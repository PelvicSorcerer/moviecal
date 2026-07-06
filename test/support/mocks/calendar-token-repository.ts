import type { CalendarTokenRepository } from '../../../src/lib/calendar-tokens';
import { TEST_CALENDAR_TOKENS, TEST_USER_IDS } from '../../../src/lib/test-data/catalog';
import { buildCalendarTokenRow } from '../factories/calendar';

export function createCalendarTokenRepository(
  overrides: Partial<CalendarTokenRepository> = {},
): CalendarTokenRepository {
  return {
    async findTokenByUserId() {
      return null;
    },
    async findUserIdByToken(token) {
      return token === TEST_CALENDAR_TOKENS.DEFAULT ? TEST_USER_IDS.OWNER : null;
    },
    async insertTokenForUser() {
      return {
        errorCode: null,
        row: buildCalendarTokenRow(),
      };
    },
    async updateTokenForUser() {
      return {
        errorCode: null,
        row: buildCalendarTokenRow({ token: 'rotated-token' }),
      };
    },
    ...overrides,
  };
}
