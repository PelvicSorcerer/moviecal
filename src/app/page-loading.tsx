import styles from './page-loading.module.css';

interface PageLoadingProps {
  page: 'search' | 'watchlists' | 'watchlist';
}

const labels = {
  search: 'Loading search…',
  watchlists: 'Loading watchlists…',
  watchlist: 'Loading watchlist…',
};

const headings = {
  search: 'Movie search',
  watchlists: 'Your watchlists',
  watchlist: 'Watchlist detail',
};

export default function PageLoading({ page }: PageLoadingProps) {
  return (
    <section className={styles.loading} aria-busy="true">
      <div role="status">
        <span className={styles.srOnly}>{labels[page]}</span>
      </div>
      <div aria-hidden="true" className={styles.content}>
        <div className={styles.hero}>
          <p className={styles.eyebrow}>{headings[page]}</p>
          <div className={`${styles.bar} ${styles.title}`} />
          <div className={`${styles.bar} ${styles.description}`} />
          {page === 'search' ? (
            <div className={styles.searchForm}>
              <div className={`${styles.bar} ${styles.input}`} />
              <div className={`${styles.bar} ${styles.button}`} />
            </div>
          ) : null}
        </div>
        <div className={styles.panel}>
          <div className={`${styles.bar} ${styles.subtitle}`} />
          <div className={styles.cards}>
            {[0, 1, 2].map((index) => (
              <div key={index} className={styles.card}>
                {page !== 'watchlists' ? <div className={styles.poster} /> : null}
                <div className={styles.details}>
                  <div className={`${styles.bar} ${styles.subtitle}`} />
                  <div className={styles.bar} />
                  <div className={`${styles.bar} ${styles.description}`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
