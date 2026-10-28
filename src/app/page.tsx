import Link from 'next/link';

import { getOptionalUser } from '../lib/auth/session';
import styles from './home.module.css';

export default async function Home() {
  const user = await getOptionalUser();

  return (
    <section className={styles.home} aria-labelledby="home-heading">
      <div className={styles.hero}>
        <p className={styles.eyebrow}>Watch together. Never miss a release.</p>
        <h2 id="home-heading" className={styles.heading}>
          {user ? 'Welcome back to moviecal.' : 'Your next movie night starts here.'}
        </h2>
        <p className={styles.intro}>
          {user
            ? 'Find your next film, catch up on your watchlists, or set up your release-date calendar feed.'
            : 'Keep a private watchlist, plan with friends on shared watchlists, and follow movie release dates in your calendar.'}
        </p>
        <div className={styles.actions}>
          {user ? (
            <>
              <Link href="/search" className={styles.primaryLink}>Search</Link>
              <Link href="/watchlist" className={styles.secondaryLink}>Watchlists</Link>
              <Link href="/settings/calendar" className={styles.secondaryLink}>
                Calendar settings
              </Link>
            </>
          ) : (
            <>
              <Link href="/sign-in" className={styles.primaryLink}>
                Sign in to get started
              </Link>
              <Link href="/search" className={styles.secondaryLink}>Search movies</Link>
            </>
          )}
        </div>
      </div>

      {!user ? (
        <div className={styles.features}>
          <div className={styles.feature}>
            <h3>Private watchlists</h3>
            <p>Save movies you want to see in a personal watchlist that stays yours.</p>
          </div>
          <div className={styles.feature}>
            <h3>Shared watchlists</h3>
            <p>Invite friends to a shared list and choose what to watch together.</p>
          </div>
          <div className={styles.feature}>
            <h3>Release-date calendar</h3>
            <p>
              Subscribe to your private iCalendar feed in Apple Calendar or another
              calendar app. Release dates stay up to date as they change.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
