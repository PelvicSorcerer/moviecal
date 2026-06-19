import {
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { isE2ECalendarTokenActive } from '../../../../lib/e2e/calendar-token-state';
import {
  E2E_USER,
  isE2ETestModeEnabled,
} from '../../../../lib/e2e/fixtures';
import { resolveCalendarTokenOwner } from '../../../../lib/calendar-tokens';
import { createSupabaseCalendarTokenRepository } from '../../../../lib/supabase/calendar-tokens';

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (isE2ETestModeEnabled() && token.startsWith('e2e-calendar-token-')) {
    if (!isE2ECalendarTokenActive(token)) {
      return new Response('Not Found', { status: 404 });
    }

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//moviecal//EN',
      `X-WR-CALNAME:${E2E_USER.email ?? 'moviecal'} calendar`,
      'END:VCALENDAR',
    ].join('\r\n');

    return new Response(ics, {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    });
  }

  const repository = createSupabaseCalendarTokenRepository({
    adminClient: createServerSupabaseServiceRoleClient(),
    userClient: createServerSupabaseServiceRoleClient(),
  });
  const ownerId = await resolveCalendarTokenOwner({
    repository,
    token,
  });

  if (!ownerId) {
    return new Response('Not Found', { status: 404 });
  }

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//moviecal//EN',
    'END:VCALENDAR'
  ].join('\r\n');

  return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
}
