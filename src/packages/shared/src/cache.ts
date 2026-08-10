/**
 * Small in-process TTL cache (IMPROVEMENTS_RESEARCH §6 — response caching for
 * frequently-read, rarely-written data like help articles and templates).
 * Deliberately minimal: per-key expiry, LRU-ish size bound, and single-flight
 * loading so a burst of identical reads produces one query. Writers must call
 * delete()/clear() on mutation — this is a same-process cache, so services
 * with multiple replicas should only cache data where brief staleness is
 * acceptable.
 */
/**
 * A load in progress, and whether an invalidation has overtaken it.
 *
 * A class rather than an object literal because the loader's continuations
 * need the record itself — to check `stale` and to prove the record still owns
 * the slot — while the record needs the promise those continuations produce.
 * Building it in a constructor breaks that cycle with `this`; the literal it
 * replaces had to open with `undefined as unknown as Promise<T>`, which is a
 * type saying "always a promise" over a field that briefly is not one.
 */
class InflightLoad<T> {
  readonly promise: Promise<T>;
  /** Set when delete()/clear() lands while this load is still running. */
  stale = false;

  constructor(start: (self: InflightLoad<T>) => Promise<T>) {
    this.promise = start(this);
  }
}

export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, InflightLoad<T>>();

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
    const pending = this.inflight.get(key);
    if (pending) pending.stale = true;
  }

  clear(): void {
    this.entries.clear();
    for (const pending of this.inflight.values()) pending.stale = true;
  }

  /**
   * Cached read-through. Concurrent calls for the same key share one loader
   * run; a loader failure is not cached.
   *
   * An invalidation that lands *while a load is in flight* has to be honoured
   * too, and dropping the entry cannot do it: there is no entry yet. The
   * loader read the row before the write, so publishing its result on
   * completion re-populated the cache with the pre-write value and served it
   * for a full TTL — after an explicit `delete`. Callers that state their
   * correctness rests on invalidation rather than on the TTL (the valuation
   * row cache, which every authorization and state check reads through) then
   * saw a superseded row for as long as the TTL allowed.
   *
   * So each load carries a `stale` flag: `delete`/`clear` set it, and a load
   * that finishes stale still answers its own callers — the read they asked
   * for was in flight when they asked — but does not populate the cache. A
   * caller arriving after the invalidation starts a fresh load rather than
   * joining the doomed one, and the newer load owns the slot.
   */
  getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);

    const pending = this.inflight.get(key);
    if (pending && !pending.stale) return pending.promise;

    const record = new InflightLoad<T>((self) =>
      loader().then(
        (value) => {
          // Only the load that still owns the slot may clear it; a stale load
          // finishing late must not evict the fresh one that replaced it.
          if (this.inflight.get(key) === self) this.inflight.delete(key);
          if (!self.stale) this.set(key, value);
          return value;
        },
        (err: unknown) => {
          if (this.inflight.get(key) === self) this.inflight.delete(key);
          throw err;
        },
      ),
    );
    this.inflight.set(key, record);
    return record.promise;
  }
}
