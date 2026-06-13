import { requireAuthenticatedPage } from '../../../lib/auth/session';

export default async function CalendarSettings() {
  const user = await requireAuthenticatedPage('/settings/calendar');

  return (
    <section className="space-y-4">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
          Protected area
        </p>
        <h2 className="mt-2 text-3xl font-semibold text-slate-950">Calendar settings</h2>
      </div>
      <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm leading-7 text-slate-600 shadow-sm">
        Signed in as <span className="font-medium text-slate-950">{user.email ?? 'unknown user'}</span>.
        Calendar token management and rotation UI will be implemented in a later
        issue, but the settings route is now server-protected.
      </p>
    </section>
  );
}
