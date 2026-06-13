import '../styles/globals.css';
import Link from 'next/link';

import { getOptionalUser } from '../lib/auth/session';

export const metadata = {
  title: 'moviecal',
  description: 'Movie watchlist and iCalendar feed (scaffold)'
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getOptionalUser();

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <header className="border-b bg-white shadow-sm">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-6 px-4 py-4">
            <div>
              <h1 className="text-lg font-semibold">moviecal</h1>
              <p className="text-xs text-slate-500">Private watchlists and calendar feeds</p>
            </div>
            <nav className="flex items-center gap-4">
              <Link href="/" className="text-sm text-slate-600">Home</Link>
              <Link href="/search" className="text-sm text-slate-600">Search</Link>
              <Link href="/watchlist" className="text-sm text-slate-600">Watchlist</Link>
              <Link href="/settings/calendar" className="text-sm text-slate-600">Calendar</Link>
              {user ? (
                <>
                  <span className="hidden text-sm text-slate-500 sm:inline">{user.email}</span>
                  <form action="/auth/sign-out" method="post">
                    <button type="submit" className="text-sm font-medium text-sky-700">
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <Link href="/sign-in" className="text-sm font-medium text-sky-700">
                  Sign in
                </Link>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
