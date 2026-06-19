import type { PostgrestError } from '@supabase/supabase-js';

import type { CalendarTokenRepository, CalendarTokenRow } from '../calendar-tokens';
import type { ServerSupabaseClient } from './server';

const calendarTokenSelect = 'id, user_id, token, created_at';

function assertCalendarTokenRow(data: unknown): CalendarTokenRow {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'string' ||
    typeof (data as { user_id?: unknown }).user_id !== 'string' ||
    typeof (data as { token?: unknown }).token !== 'string' ||
    typeof (data as { created_at?: unknown }).created_at !== 'string'
  ) {
    throw new Error('Supabase returned an invalid calendar token row.');
  }

  return data as CalendarTokenRow;
}

function throwSupabaseError(error: PostgrestError | null): never {
  throw new Error(error?.message ?? 'Supabase request failed.');
}

export function createSupabaseCalendarTokenRepository(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}): CalendarTokenRepository {
  return {
    async findTokenByUserId(userId) {
      const { data, error } = await args.userClient
        .from('calendar_tokens')
        .select(calendarTokenSelect)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return data ? assertCalendarTokenRow(data) : null;
    },

    async findUserIdByToken(token) {
      const { data, error } = await args.adminClient
        .from('calendar_tokens')
        .select('user_id')
        .eq('token', token)
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return data?.user_id ?? null;
    },

    async insertTokenForUser(userId, token) {
      const { data, error } = await args.userClient
        .from('calendar_tokens')
        .insert({
          token,
          user_id: userId,
        })
        .select(calendarTokenSelect)
        .single();

      if (error) {
        return {
          errorCode: error.code ?? null,
          row: null,
        };
      }

      return {
        errorCode: null,
        row: assertCalendarTokenRow(data),
      };
    },

    async updateTokenForUser(userId, token) {
      const { data, error } = await args.userClient
        .from('calendar_tokens')
        .update({ token })
        .eq('user_id', userId)
        .select(calendarTokenSelect)
        .maybeSingle();

      if (error) {
        return {
          errorCode: error.code ?? null,
          row: null,
        };
      }

      return {
        errorCode: null,
        row: data ? assertCalendarTokenRow(data) : null,
      };
    },
  };
}
