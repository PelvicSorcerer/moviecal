import Link from 'next/link';

import styles from './not-found.module.css';

export const metadata = {
  title: 'Page not found',
};

export default function NotFound() {
  return (
    <section className={styles.notFound} aria-labelledby="not-found-heading">
      <p className={styles.eyebrow}>404 · moviecal</p>
      <h2 id="not-found-heading" className={styles.heading}>Page not found</h2>
      <p className={styles.help}>
        This page is missing, but your next movie night can start at Home, Search, or Watchlists.
      </p>
      <nav className={styles.actions} aria-label="Find your next page">
        <Link href="/" className={styles.primaryLink}>Home</Link>
        <Link href="/search">Search</Link>
        <Link href="/watchlist">Watchlists</Link>
      </nav>
    </section>
  );
}
