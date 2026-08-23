/**
 * Small in-process TTL cache (IMPROVEMENTS_RESEARCH §6 — response caching for
 * frequently-read, rarely-written data like help articles and templates).
 * Deliberately minimal: per-key expiry, an LRU size bound (reads count as use,
 * so a spray of one-shot keys cannot evict a hot one — see `get`), and
 * single-flight loading so a burst of identical reads produces one query.
 * Writers must call delete()/clear() on mutation — this is a same-process
 * cache, so services with multiple replicas should only cache data where brief
 * staleness is acceptable.
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
  /**
   * Tags invalidated since this load started.
   *
   * The `stale` flag cannot cover a tag invalidation, and the reason is the
   * whole difficulty of tagging a read-through cache: a load in flight has no
   * tags yet. Its tags are derived from the value, and the value is what it has
   * not got. So `invalidateTag` cannot decide whether a running load is
   * affected — it can only record what was invalidated and leave the decision
   * to the load, which makes it at completion when it finally knows what it
   * loaded. A load resolving to a value carrying one of these tags read the row
   * before the write and must not publish it.
   */
  readonly invalidatedTags = new Set<string>();

  constructor(start: (self: InflightLoad<T>) => Promise<T>) {
    this.promise = start(this);
  }
}

/**
 * How a cached value declares what it belongs to.
 *
 * Tags exist because the keys a value is filed under and the thing a write
 * changes are not the same shape. Branding is the case that forced it: one
 * tenant's row is cached under three keys — its slug, its subdomain and its
 * partner id — and a write knows only the partner id. Worse, the write can
 * *change* the subdomain, so the entry to drop is filed under the label the
 * tenant had before the write, which the writer no longer has. Enumerating the
 * key shapes at the call site is what a partial invalidation would require, and
 * it is exactly the enumeration that goes stale the next time a key shape is
 * added.
 *
 * A tag inverts that. The *loader* knows what it loaded, so it tags the entry
 * with the partner id whichever key it was filed under, and the writer names
 * the partner id it just wrote. Neither side has to know the other's key shapes.
 */
export type CacheTags = readonly string[];

export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number; tags?: CacheTags }>();
  private readonly inflight = new Map<string, InflightLoad<T>>();
  /** tag -> keys carrying it, so invalidation is a lookup rather than a scan. */
  private readonly byTag = new Map<string, Set<string>>();

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

  /**
   * Removes an entry and every tag link pointing at it.
   *
   * Every path that drops an entry goes through here — expiry, explicit delete,
   * LRU eviction, tag invalidation. A path that forgot to would leave the key
   * in `byTag`, and a later `invalidateTag` would walk to a key that is not
   * there: harmless on its own, but the set grows without bound on a cache
   * whose whole purpose is to be long-lived, and a re-used key would then be
   * invalidated by a tag it never carried.
   */
  private dropEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (!entry.tags) return;
    for (const tag of entry.tags) {
      const keys = this.byTag.get(tag);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) this.byTag.delete(tag);
    }
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.dropEntry(key);
      return undefined;
    }
    // Re-insert on the way out, so the Map's iteration order is recency of
    // *use* rather than recency of write — which is what the eviction loop in
    // `set` reads it as. Without this, eviction is insertion-ordered, and an
    // entry being read on every single request is evicted just as readily as
    // one nothing has touched since it was stored.
    //
    // That distinction is the difference between a bounded cache and no cache
    // at all, because the keys here are chosen by the caller. Both anonymous
    // read-through routes cache their misses under a caller-supplied string —
    // `slug:<anything>` for a blog post, `key:<slug>` for a tenant's login
    // brand — so a crawler walking dead links, or anyone sending 500 made-up
    // slugs, inserts one entry per request. Insertion-ordered eviction hands
    // those one-shot keys the whole cache and evicts everything real, including
    // the `partner:<id>` entries that the *signed-in* SPA reads on every page
    // load. The cache would switch itself off under precisely the traffic it
    // exists to absorb.
    //
    // Recency-ordered eviction inverts that: a key touched once sits at the
    // front and goes first, while a key read on every request keeps moving to
    // the back and survives. It is the same defence, and the same reasoning,
    // that `BoundedWindowStore` in the rate limiter already documents — "a
    // flood of one-shot keys cannot wash out the entry that is actually
    // tracking it".
    //
    // `expiresAt` is deliberately carried over untouched. Recency is not a
    // lease renewal: a value stays as stale as the clock says it is however
    // often it is read, or a hot key would never be re-read from the source.
    // Tags are untouched for the same reason they need no relinking — the key
    // string and its tags are both unchanged, so `byTag` still points here.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, tags?: CacheTags): void {
    // Re-insert so Map iteration order doubles as recency for eviction. Via
    // dropEntry rather than a bare delete, so re-setting a key under *different*
    // tags does not leave it linked to the old ones — a value that has moved
    // tenants would otherwise still be dropped by its previous tenant's writes.
    this.dropEntry(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.opts.ttlMs, tags });
    if (tags) {
      for (const tag of tags) {
        let keys = this.byTag.get(tag);
        if (!keys) this.byTag.set(tag, (keys = new Set()));
        keys.add(key);
      }
    }
    const max = this.opts.maxEntries ?? 500;
    while (this.entries.size > max) {
      this.dropEntry(this.entries.keys().next().value as string);
    }
  }

  delete(key: string): void {
    this.dropEntry(key);
    const pending = this.inflight.get(key);
    if (pending) pending.stale = true;
  }

  /**
   * Drops every entry carrying `tag`, and stops any load in flight from
   * re-publishing one.
   *
   * The second half is what makes this safe to rely on rather than merely
   * usually right. See {@link InflightLoad.invalidatedTags}: a load that has not
   * finished has no tags to match against, so the tag is recorded on every
   * running load and checked when each one completes. Without that, an
   * invalidation racing a load would drop the entry and then watch the load put
   * the pre-write value straight back — the failure `getOrLoad`'s `stale` flag
   * was added for, arrived at through the tag instead of the key.
   *
   * Recorded on *every* in-flight load rather than only the ones that look
   * relevant, because which ones are relevant is precisely what cannot be known
   * yet. The cost is one set insertion per running load, and loads in flight
   * are bounded by the number of distinct keys being missed at once.
   */
  invalidateTag(tag: string): void {
    for (const key of this.byTag.get(tag) ?? []) {
      // Not dropEntry: it mutates the very set being iterated. The whole set
      // goes below, so unlinking key by key would be wasted work anyway — but
      // the *other* tags those keys carry still have to be unlinked.
      const entry = this.entries.get(key);
      this.entries.delete(key);
      for (const other of entry?.tags ?? []) {
        if (other === tag) continue;
        const keys = this.byTag.get(other);
        if (!keys) continue;
        keys.delete(key);
        if (keys.size === 0) this.byTag.delete(other);
      }
    }
    this.byTag.delete(tag);
    for (const pending of this.inflight.values()) pending.invalidatedTags.add(tag);
  }

  clear(): void {
    this.entries.clear();
    this.byTag.clear();
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
  getOrLoad(key: string, loader: () => Promise<T>, tagsOf?: (value: T) => CacheTags | undefined): Promise<T> {
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
          // Tags are derived here rather than passed in because this is the
          // first moment they can be known — for the read-through case that
          // motivated them, the tag *is* a field of the row being loaded.
          const tags = tagsOf?.(value);
          const invalidated = tags?.some((tag) => self.invalidatedTags.has(tag)) ?? false;
          if (!self.stale && !invalidated) this.set(key, value, tags);
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
