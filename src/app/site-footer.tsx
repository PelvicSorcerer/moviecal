import Link from 'next/link';

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <p className="site-footer-brand">moviecal</p>
        <nav aria-label="Footer navigation" className="site-footer-navigation">
          <Link href="/search">Search</Link>
          <Link href="/watchlist">Watchlists</Link>
          <Link href="/settings/calendar">Calendar settings</Link>
        </nav>
        <p className="site-footer-attribution">
          This product uses the TMDb API but is not endorsed or certified by TMDb.
        </p>
      </div>
    </footer>
  );
}
