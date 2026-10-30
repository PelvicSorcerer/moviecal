export type TMDbCacheClock = () => number;

export interface TMDbResponseCacheOptions {
  maxEntries?: number;
  now?: TMDbCacheClock;
}

interface CachedValue {
  expiresAt: number;
  value: unknown;
}

export const DEFAULT_TMDB_CACHE_MAX_ENTRIES = 500;

export class TMDbResponseCache {
  private readonly entries = new Map<string, CachedValue>();

  private readonly inFlight = new Map<string, Promise<unknown>>();

  private readonly maxEntries: number;

  private readonly now: TMDbCacheClock;

  private generation = 0;

  constructor(options: TMDbResponseCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_TMDB_CACHE_MAX_ENTRIES;

    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer.');
    }

    this.maxEntries = maxEntries;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys(), ...this.inFlight.keys()];
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inFlight.clear();
  }

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);

    if (cached) {
      this.entries.delete(key);

      if (cached.expiresAt > this.now()) {
        this.entries.set(key, cached);
        return cached.value as T;
      }
    }

    const pending = this.inFlight.get(key);

    if (pending) {
      return pending as Promise<T>;
    }

    const generation = this.generation;
    let request!: Promise<T>;
    request = (async () => {
      try {
        const value = await load();

        if (generation === this.generation) {
          this.store(key, value, ttlMs);
        }

        return value;
      } finally {
        if (this.inFlight.get(key) === request) {
          this.inFlight.delete(key);
        }
      }
    })();

    this.inFlight.set(key, request);

    return request;
  }

  private store(key: string, value: unknown, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      this.entries.delete(oldestKey);
    }
  }
}

export function createTMDbCacheKey(
  path: string,
  searchParams: Record<string, string | number>,
): string {
  const params = new URLSearchParams();

  for (const key of Object.keys(searchParams).sort()) {
    params.set(key, String(searchParams[key]));
  }

  const query = params.toString();

  return query ? `${path}?${query}` : path;
}
