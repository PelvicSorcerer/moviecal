import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getSignedInRedirect } from '../../lib/auth/session';

export const metadata: Metadata = {
  title: 'Sign in | moviecal',
  description: 'Sign in to access your private movie watchlist and calendar settings.',
};

const errorMessages: Record<string, string> = {
  'auth-unavailable':
    'Authentication is unavailable until Supabase credentials are configured for this environment.',
  'invalid-credentials': 'The email or password was not accepted. Try again with a valid test account.',
  'missing-fields': 'Enter both an email address and a password.',
};

function readSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const nextPath = readSearchParam(params.next);
  const signedInRedirect = await getSignedInRedirect(nextPath);

  if (signedInRedirect) {
    redirect(signedInRedirect);
  }

  const errorKey = readSearchParam(params.error);
  const errorMessage = errorKey ? errorMessages[errorKey] : undefined;

  return (
    <section className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-700">
          Authentication
        </p>
        <h2 className="text-3xl font-semibold text-slate-950">Sign in to moviecal</h2>
        <p className="text-sm leading-6 text-slate-600">
          Use a disposable or dev-only Supabase email/password account to access
          your private watchlist and calendar settings.
        </p>
      </div>

      {errorMessage ? (
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      ) : null}

      <form action="/auth/sign-in" method="post" className="mt-6 space-y-4">
        <input type="hidden" name="next" value={nextPath ?? '/watchlist'} />

        <label className="block space-y-2">
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500"
            type="email"
            name="email"
            autoComplete="email"
            required
          />
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-slate-700">Password</span>
          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-500"
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </label>

        <button
          type="submit"
          className="w-full rounded-xl bg-sky-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-800"
        >
          Sign in
        </button>
      </form>

      <p className="mt-6 text-sm text-slate-500">
        Don&apos;t have test credentials yet? Configure Supabase in your local
        environment first, then create a disposable account in the Supabase auth
        dashboard.
      </p>

      <div className="mt-6 text-sm">
        <Link href="/" className="text-sky-700 hover:text-sky-800">
          Return to the home page
        </Link>
      </div>
    </section>
  );
}
