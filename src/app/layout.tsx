import '../styles/globals.css';
import Link from 'next/link';

import { getOptionalUser } from '../lib/auth/session';
import SiteNavigation from './site-navigation';
import SiteFooter from './site-footer';

// Page titles come from each route's metadata and are suffixed by this template.
export const metadata = {
  title: {
    default: 'moviecal',
    template: '%s | moviecal',
  },
  description: 'Keep private and shared movie watchlists, and follow release dates with a personal iCalendar feed.'
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getOptionalUser();

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <header className="site-header border-b bg-white shadow-sm">
          <div className="site-header-inner">
            <div className="site-brand">
              <h1 className="text-lg font-semibold">moviecal</h1>
              <p className="text-xs text-slate-500">Shared watchlists and calendar feeds</p>
            </div>
            <SiteNavigation />
            <div className="site-session">
              {user ? (
                <>
                  <span className="site-user-email text-sm text-slate-500">{user.email}</span>
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
            </div>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="mx-auto max-w-4xl px-4 py-8">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
