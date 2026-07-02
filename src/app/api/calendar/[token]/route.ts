import {
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { buildCalendarFeed } from '../../../../lib/calendar-feed';
import { isE2ECalendarTokenActive } from '../../../../lib/e2e/calendar-token-state';
import {
  E2E_USER,
  isE2ETestModeEnabled,
} from '../../../../lib/e2e/fixtures';
import { resolveCalendarTokenOwner } from '../../../../lib/calendar-tokens';
import { createSupabaseCalendarTokenRepository } from '../../../../lib/supabase/calendar-tokens';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';
import { listCalendarWatchlistItems } from '../../../../lib/watchlist';

function createCalendarTokenRepository() {
  const adminClient = createServerSupabaseServiceRoleClient();

  return createSupabaseCalendarTokenRepository({
    adminClient,
    userClient: adminClient,
  });
}

function createWatchlistRepository() {
  const adminClient = createServerSupabaseServiceRoleClient();

  return createSupabaseWatchlistRepository({
    adminClient,
    userClient: adminClient,
  });
}

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

  const repository = createCalendarTokenRepository();
  const ownerId = await resolveCalendarTokenOwner({
    repository,
    token,
  });

  if (!ownerId) {
    return new Response('Not Found', { status: 404 });
  }

  const items = await listCalendarWatchlistItems({
    repository: createWatchlistRepository(),
    userId: ownerId,
  });

  const ics = buildCalendarFeed({
    items,
    userId: ownerId,
  });

  return new Response(ics, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
}
