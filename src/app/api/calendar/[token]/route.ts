import {
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { resolveCalendarTokenOwner } from '../../../../lib/calendar-tokens';
import { createSupabaseCalendarTokenRepository } from '../../../../lib/supabase/calendar-tokens';

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
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
