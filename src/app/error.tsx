'use client';

import Link from 'next/link';

import styles from './error.module.css';

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorPage({ reset }: ErrorPageProps) {
  return (
    <section className={styles.errorPage} aria-labelledby="error-heading">
      <p className={styles.eyebrow}>moviecal</p>
      <h2 id="error-heading" className={styles.heading}>Something went wrong</h2>
      <p className={styles.help}>
        Try again, or head Home to plan your next movie night.
      </p>
      <div className={styles.actions}>
        <button type="button" onClick={reset} className={styles.retry}>Try again</button>
        <Link href="/">Home</Link>
      </div>
    </section>
  );
}
