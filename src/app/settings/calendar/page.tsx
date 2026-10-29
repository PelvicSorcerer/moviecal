import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';

import { requireAuthenticatedPageSession } from '../../../lib/auth/session';
import {
  buildCalendarSubscriptionUrl,
  getOrCreateCalendarToken,
} from '../../../lib/calendar-tokens';
import { syncE2ECalendarToken } from '../../../lib/e2e/calendar-token-state';
import { E2E_USER } from '../../../lib/e2e/fixtures';
import { readRequestOrigin } from '../../../lib/request-origin';
import { createSupabaseCalendarTokenRepository } from '../../../lib/supabase/calendar-tokens';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../lib/supabase/server';
import CalendarSubscription from './subscription';

export const metadata: Metadata = {
  title: 'Calendar settings',
};

export default async function CalendarSettings() {
  const session = await requireAuthenticatedPageSession('/settings/calendar');
  const token = session.user.id === E2E_USER.id
    ? syncE2ECalendarToken(await cookies())
    : (await getOrCreateCalendarToken({
        repository: createSupabaseCalendarTokenRepository({
          adminClient: createServerSupabaseServiceRoleClient(),
          userClient: createServerSupabaseClient(session.accessToken),
        }),
        userId: session.user.id,
      })).token;
  const subscriptionUrl = buildCalendarSubscriptionUrl(
    readRequestOrigin(await headers()),
    token,
  );

  return (
    <section className="min-w-0 space-y-4">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
          Calendar subscription
        </p>
        <h2 className="mt-2 text-3xl font-semibold text-slate-950">Calendar settings</h2>
      </div>
      <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 text-sm leading-7 text-slate-600 shadow-sm">
        <p>
          Signed in as{' '}
          <span className="font-medium text-slate-950">
            {session.user.email ?? 'unknown user'}
          </span>
          .
        </p>
        <CalendarSubscription key={subscriptionUrl} subscriptionUrl={subscriptionUrl} />
      </div>
    </section>
  );
}
