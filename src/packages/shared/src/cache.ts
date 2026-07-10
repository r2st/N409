/**
 * Small in-process TTL cache (IMPROVEMENTS_RESEARCH §6 — response caching for
 * frequently-read, rarely-written data like help articles and templates).
 * Deliberately minimal: per-key expiry, LRU-ish size bound, and single-flight
 * loading so a burst of identical reads produces one query. Writers must call
 * delete()/clear() on mutation — this is a same-process cache, so services
 * with multiple replicas should only cache data where brief staleness is
 * acceptable.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly opts: {
      /** How long an entry stays valid. */
      ttlMs: number;
      /** Oldest entries are evicted beyond this (default 500). */
      maxEntries?: number;
      /** Injectable clock for tests. */
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Re-insert so Map iteration order doubles as recency for eviction.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.opts.ttlMs });
    const max = this.opts.maxEntries ?? 500;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Cached read-through. Concurrent calls for the same key share one loader
   * run; a loader failure is not cached.
   */
  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const load = loader().then(
      (value) => {
        this.inflight.delete(key);
        this.set(key, value);
        return value;
      },
      (err: unknown) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, load);
    return load;
  }
}
