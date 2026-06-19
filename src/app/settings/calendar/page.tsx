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
import { rotateCalendarTokenAction } from './actions';

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
    <section className="space-y-4">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
          Protected area
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
        <div className="space-y-2">
          <p className="font-medium text-slate-950">Private subscription URL</p>
          <p>
            Treat this URL like a password. Anyone with the full link can read
            your calendar feed until you rotate the token.
          </p>
          <code className="block overflow-x-auto rounded-xl bg-slate-950 px-4 py-3 text-xs text-slate-100">
            {subscriptionUrl}
          </code>
        </div>
        <form action={rotateCalendarTokenAction}>
          <button
            type="submit"
            className="rounded-full bg-sky-700 px-4 py-2 font-medium text-white transition hover:bg-sky-800"
          >
            Rotate subscription URL
          </button>
        </form>
      </div>
    </section>
  );
}
