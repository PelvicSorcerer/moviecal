'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { createAccessTokenCookieOptions } from '../../../lib/auth/cookies';
import { requireAuthenticatedPageSession } from '../../../lib/auth/session';
import { rotateCalendarToken } from '../../../lib/calendar-tokens';
import { rotateE2ECalendarToken } from '../../../lib/e2e/calendar-token-state';
import {
  E2E_CALENDAR_TOKEN_COOKIE,
  E2E_SESSION,
  E2E_USER,
} from '../../../lib/e2e/fixtures';
import { createSupabaseCalendarTokenRepository } from '../../../lib/supabase/calendar-tokens';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../lib/supabase/server';

export async function rotateCalendarTokenAction(): Promise<void> {
  const session = await requireAuthenticatedPageSession('/settings/calendar');

  if (session.user.id === E2E_USER.id) {
    const cookieStore = await cookies();
    const nextToken = rotateE2ECalendarToken(cookieStore);
    cookieStore.set(
      E2E_CALENDAR_TOKEN_COOKIE,
      nextToken,
      createAccessTokenCookieOptions(E2E_SESSION.expiresIn),
    );
    revalidatePath('/settings/calendar');
    redirect('/settings/calendar');
  }

  const repository = createSupabaseCalendarTokenRepository({
    adminClient: createServerSupabaseServiceRoleClient(),
    userClient: createServerSupabaseClient(session.accessToken),
  });

  await rotateCalendarToken({
    repository,
    userId: session.user.id,
  });

  revalidatePath('/settings/calendar');
  redirect('/settings/calendar');
}
