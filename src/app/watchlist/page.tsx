import { requireAuthenticatedPage } from '../../lib/auth/session';

export default async function WatchlistPage() {
  const user = await requireAuthenticatedPage('/watchlist');

  return (
    <section className="space-y-4">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
          Protected area
        </p>
        <h2 className="mt-2 text-3xl font-semibold text-slate-950">Your watchlist</h2>
      </div>
      <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm leading-7 text-slate-600 shadow-sm">
        Signed in as <span className="font-medium text-slate-950">{user.email ?? 'unknown user'}</span>.
        Watchlist persistence and TMDb-backed additions are still out of scope for
        this issue, but this page now requires authentication before it will render.
      </p>
    </section>
  );
}
