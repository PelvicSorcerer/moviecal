'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireAuthenticatedPageSession } from '../../../lib/auth/session';
import { rotateCalendarToken } from '../../../lib/calendar-tokens';
import { createSupabaseCalendarTokenRepository } from '../../../lib/supabase/calendar-tokens';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../lib/supabase/server';

export async function rotateCalendarTokenAction(): Promise<void> {
  const session = await requireAuthenticatedPageSession('/settings/calendar');
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
