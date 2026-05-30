import '../styles/globals.css';

export const metadata = {
  title: 'moviecal',
  description: 'Movie watchlist and iCalendar feed (scaffold)'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <header className="border-b bg-white shadow-sm">
          <div className="mx-auto max-w-4xl px-4 py-4 flex items-center justify-between">
            <h1 className="text-lg font-semibold">moviecal (scaffold)</h1>
            <nav className="space-x-4">
              <a href="/" className="text-sm text-slate-600">Home</a>
              <a href="/search" className="text-sm text-slate-600">Search</a>
              <a href="/watchlist" className="text-sm text-slate-600">Watchlist</a>
              <a href="/settings/calendar" className="text-sm text-slate-600">Calendar</a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
