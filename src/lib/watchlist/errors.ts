export class WatchlistInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'WatchlistInputError';
  }
}

export class WatchlistNotFoundError extends Error {
  readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = 'WatchlistNotFoundError';
  }
}

export class WatchlistAccessError extends Error {
  readonly status = 403;

  constructor(
    message: string,
    readonly reason: 'forbidden' | 'not_found' = 'forbidden',
  ) {
    super(message);
    this.name = 'WatchlistAccessError';
  }
}

export class WatchlistDataError extends Error {
  readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = 'WatchlistDataError';
  }
}
