import Link from 'next/link';

export default function Home() {
  return (
    <section className="space-y-10">
      <div className="rounded-3xl bg-slate-950 px-8 py-10 text-white shadow-xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-200">
          Early MVP
        </p>
        <h2 className="mt-3 text-4xl font-semibold leading-tight">
          Track release dates without losing the privacy of your own watchlist.
        </h2>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-200">
          moviecal is building toward a private watchlist and personal calendar feed.
          This authentication foundation now protects user-only areas before the
          watchlist and calendar features fill in behind it.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/sign-in"
            className="rounded-full bg-sky-400 px-5 py-3 text-sm font-semibold text-slate-950"
          >
            Sign in
          </Link>
          <Link
            href="/watchlist"
            className="rounded-full border border-white/20 px-5 py-3 text-sm font-semibold text-white"
          >
            Open protected watchlist
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-950">Sign in</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Email/password auth is the MVP path using disposable or dev-only
            Supabase accounts.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-950">Protect pages</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Watchlist and calendar settings now require an authenticated session
            before the app will render them.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-950">Protect APIs</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            User-scoped endpoints reject anonymous requests on the server instead
            of trusting client-side navigation alone.
          </p>
        </div>
      </div>
    </section>
  );
}
