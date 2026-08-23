import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/cache.js';

describe('TtlCache', () => {
  it('returns cached values within the TTL and expires them after', () => {
    let now = 1_000;
    const cache = new TtlCache<string>({ ttlMs: 100, now: () => now });
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
    now += 99;
    expect(cache.get('k')).toBe('v');
    now += 1;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently used entries beyond maxEntries', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('counts a read as use, so the write order is not the eviction order', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    // `a` is the oldest *write* but the newest *use*, so `b` is what goes.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  /**
   * The reason `get` re-inserts, stated as the property that matters rather
   * than as the ordering that produces it.
   *
   * Both anonymous read-through routes cache their misses under a key the
   * caller supplies — `slug:<anything>`, `key:<slug>` — so anyone can insert
   * one entry per request without limit. If eviction went by write order, an
   * entry re-read on *every* request would be evicted just as fast as the
   * one-shot keys, and the cache would stop caching exactly under the traffic
   * it exists to absorb. Fifty times the cache's capacity is sprayed through
   * here and the hot key must still be there at the end.
   */
  it('keeps a continuously-read entry through a spray of one-shot keys', () => {
    const max = 10;
    const cache = new TtlCache<string>({ ttlMs: 10_000, maxEntries: max });
    cache.set('partner:real', 'brand');
    for (let i = 0; i < max * 50; i++) {
      // What the signed-in SPA does on every page load, interleaved with...
      expect(cache.get('partner:real')).toBe('brand');
      // ...an anonymous caller inventing another slug that does not exist.
      cache.set(`key:made-up-${i}`, 'null');
    }
    expect(cache.get('partner:real')).toBe('brand');
  });

  it('does not renew the TTL when a read refreshes recency', () => {
    let now = 1_000;
    const cache = new TtlCache<string>({ ttlMs: 100, now: () => now });
    cache.set('k', 'v');
    // Read it constantly across the whole TTL: recency moves, expiry does not.
    for (let i = 0; i < 9; i++) {
      now += 10;
      expect(cache.get('k')).toBe('v');
    }
    now += 10;
    expect(cache.get('k')).toBeUndefined();
  });

  it('keeps tag invalidation working after a read has re-inserted the entry', () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    cache.set('a', '1', ['t']);
    expect(cache.get('a')).toBe('1'); // re-inserts; byTag must still point here
    cache.invalidateTag('t');
    expect(cache.get('a')).toBeUndefined();
  });

  it('single-flights concurrent loads for the same key', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return 'loaded';
    };
    const [a, b] = await Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
    expect(a).toBe('loaded');
    expect(b).toBe('loaded');
    expect(loads).toBe(1);
    // Now served from cache without touching the loader.
    expect(await cache.getOrLoad('k', loader)).toBe('loaded');
    expect(loads).toBe(1);
  });

  it('does not cache loader failures', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    let attempt = 0;
    const loader = async () => {
      attempt++;
      if (attempt === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(cache.getOrLoad('k', loader)).rejects.toThrow('boom');
    expect(await cache.getOrLoad('k', loader)).toBe('ok');
  });

  it('caches null values (negative caching)', async () => {
    const cache = new TtlCache<string | null>({ ttlMs: 10_000 });
    let loads = 0;
    const loader = async () => {
      loads++;
      return null;
    };
    expect(await cache.getOrLoad('missing', loader)).toBeNull();
    expect(await cache.getOrLoad('missing', loader)).toBeNull();
    expect(loads).toBe(1);
  });

  it('does not publish a load that was invalidated while it was in flight', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    let release!: (v: string) => void;
    let loads = 0;
    const slowLoader = () => {
      loads++;
      return new Promise<string>((r) => {
        release = r;
      });
    };

    // The read starts before the write, so it returns the pre-write row...
    const inflight = cache.getOrLoad('k', slowLoader);
    cache.delete('k'); // ...and the writer invalidates while it is still open.
    release('stale');
    expect(await inflight).toBe('stale'); // the caller still gets its own read

    // But the superseded value must not have been cached: the next read
    // reloads rather than serving what the delete was meant to drop.
    expect(cache.get('k')).toBeUndefined();
    expect(await cache.getOrLoad('k', async () => 'fresh')).toBe('fresh');
    expect(loads).toBe(1);
    expect(cache.get('k')).toBe('fresh');
  });

  it('honours clear() against every load in flight', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    const releases: Array<(v: string) => void> = [];
    const loader = () => new Promise<string>((r) => releases.push(r));

    const a = cache.getOrLoad('a', loader);
    const b = cache.getOrLoad('b', loader);
    cache.clear();
    releases[0]!('stale-a');
    releases[1]!('stale-b');
    await Promise.all([a, b]);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('starts a fresh load for a caller arriving after the invalidation', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    const releases: Array<(v: string) => void> = [];
    const loader = () => new Promise<string>((r) => releases.push(r));

    const first = cache.getOrLoad('k', loader);
    cache.delete('k');
    // This caller asked after the write landed, so it must not be handed the
    // doomed read — it gets its own.
    const second = cache.getOrLoad('k', loader);
    expect(releases).toHaveLength(2);

    releases[1]!('fresh');
    releases[0]!('stale');
    expect(await first).toBe('stale');
    expect(await second).toBe('fresh');
    // The later load owns the slot, so its value is what got cached.
    expect(cache.get('k')).toBe('fresh');
  });

  it('lets a stale load finishing late leave the fresh entry alone', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    const releases: Array<(v: string) => void> = [];
    const loader = () => new Promise<string>((r) => releases.push(r));

    const first = cache.getOrLoad('k', loader);
    cache.delete('k');
    const second = cache.getOrLoad('k', loader);
    releases[1]!('fresh');
    await second;
    expect(cache.get('k')).toBe('fresh');

    // The abandoned load resolves afterwards and must not evict or overwrite.
    releases[0]!('stale');
    await first;
    expect(cache.get('k')).toBe('fresh');
  });

  it('delete and clear invalidate entries', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    cache.clear();
    expect(cache.get('b')).toBeUndefined();
  });
});

/**
 * Tag-scoped invalidation.
 *
 * The property being bought is a *bound on blast radius*: a write to one tenant
 * must drop that tenant's entries and no others. That is easy to assert and
 * easy to get almost-right, so most of what follows is about the ways an
 * almost-right implementation leaks — a re-tagged key still linked to its old
 * tag, an evicted key still sitting in the tag index, and above all a load in
 * flight that finishes after the invalidation and puts the pre-write value
 * straight back.
 */
describe('TtlCache tags', () => {
  it('drops only the entries carrying the tag', () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    cache.set('key:acme', 'acme', ['partner:A']);
    cache.set('subdomain:acme', 'acme', ['partner:A']);
    cache.set('partner:A', 'acme', ['partner:A']);
    cache.set('partner:B', 'other', ['partner:B']);
    cache.set('untagged', 'plain');

    cache.invalidateTag('partner:A');

    // All three of one tenant's key shapes, without the writer naming any.
    expect(cache.get('key:acme')).toBeUndefined();
    expect(cache.get('subdomain:acme')).toBeUndefined();
    expect(cache.get('partner:A')).toBeUndefined();
    // …and nobody else's.
    expect(cache.get('partner:B')).toBe('other');
    expect(cache.get('untagged')).toBe('plain');
  });

  it('is a no-op for a tag nothing carries', () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    cache.set('a', '1', ['t']);
    cache.invalidateTag('nobody');
    expect(cache.get('a')).toBe('1');
  });

  it('drops an entry by any one of its tags', () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    cache.set('a', '1', ['x', 'y']);
    cache.invalidateTag('y');
    expect(cache.get('a')).toBeUndefined();
  });

  it('unlinks the other tags of an entry it drops', () => {
    // Otherwise `x` still points at `a`, and a later re-set of `a` under a
    // different tag would be dropped by an `x` invalidation it never joined.
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    cache.set('a', '1', ['x', 'y']);
    cache.invalidateTag('y');
    cache.set('a', '2', ['z']);
    cache.invalidateTag('x');
    expect(cache.get('a')).toBe('2');
  });

  it('forgets a key´s old tags when it is re-set under new ones', () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    cache.set('a', '1', ['old']);
    cache.set('a', '2', ['new']);
    cache.invalidateTag('old');
    expect(cache.get('a')).toBe('2');
    cache.invalidateTag('new');
    expect(cache.get('a')).toBeUndefined();
  });

  it('does not resurrect an evicted key through its tag', () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000, maxEntries: 1 });
    cache.set('a', '1', ['t']);
    cache.set('b', '2', ['t']); // evicts a
    cache.invalidateTag('t');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    // Re-set `a` untagged: if eviction had left it linked to `t`, this would
    // vanish on the next `t` invalidation despite carrying no tags.
    cache.set('a', '3');
    cache.invalidateTag('t');
    expect(cache.get('a')).toBe('3');
  });

  it('does not resurrect an expired key through its tag', () => {
    let now = 1_000;
    const cache = new TtlCache<string>({ ttlMs: 100, now: () => now });
    cache.set('a', '1', ['t']);
    now += 200;
    expect(cache.get('a')).toBeUndefined(); // expiry unlinks
    cache.set('a', '2');
    cache.invalidateTag('t');
    expect(cache.get('a')).toBe('2');
  });

  it('clear() forgets the tag index too', () => {
    const cache = new TtlCache<string>({ ttlMs: 10_000 });
    cache.set('a', '1', ['t']);
    cache.clear();
    cache.set('a', '2');
    cache.invalidateTag('t');
    expect(cache.get('a')).toBe('2');
  });

  it('tags an entry loaded through getOrLoad from the value it loaded', async () => {
    // The read-through case: the tag is a field of the row, so it cannot be
    // supplied at call time — only derived once the load resolves.
    const cache = new TtlCache<{ id: string }>({ ttlMs: 10_000 });
    await cache.getOrLoad(
      'subdomain:acme',
      async () => ({ id: 'A' }),
      (v) => [`partner:${v.id}`],
    );
    expect(cache.get('subdomain:acme')).toEqual({ id: 'A' });
    cache.invalidateTag('partner:A');
    expect(cache.get('subdomain:acme')).toBeUndefined();
  });

  it('does not publish a load that finishes after its tag was invalidated', async () => {
    // The race that makes tag invalidation trustworthy rather than usually
    // right. The load read the row before the write; publishing it would serve
    // the pre-write value for a full TTL, *after* an explicit invalidation.
    const cache = new TtlCache<{ id: string; brand: string }>({ ttlMs: 10_000 });
    let release: (v: { id: string; brand: string }) => void = () => {};
    const started = cache.getOrLoad(
      'subdomain:acme',
      () => new Promise((resolve) => (release = resolve)),
      (v) => [`partner:${v.id}`],
    );

    cache.invalidateTag('partner:A'); // the write lands mid-load
    release({ id: 'A', brand: 'stale' });

    // The caller that asked still gets an answer — the read it asked for was in
    // flight when it asked…
    await expect(started).resolves.toEqual({ id: 'A', brand: 'stale' });
    // …but nothing was cached, so the next reader goes back to the database.
    expect(cache.get('subdomain:acme')).toBeUndefined();
  });

  it('publishes a load whose value carries an unrelated tag', async () => {
    // The other half: invalidating one tenant must not throw away a concurrent
    // load belonging to a different one.
    const cache = new TtlCache<{ id: string }>({ ttlMs: 10_000 });
    let release: (v: { id: string }) => void = () => {};
    const started = cache.getOrLoad(
      'subdomain:other',
      () => new Promise((resolve) => (release = resolve)),
      (v) => [`partner:${v.id}`],
    );

    cache.invalidateTag('partner:A');
    release({ id: 'B' });
    await started;

    expect(cache.get('subdomain:other')).toEqual({ id: 'B' });
  });

  it('leaves an untagged load alone when a tag is invalidated', async () => {
    // A `null` miss carries no tag and so cannot be matched by one. This is why
    // the branding route drops those keys by name at the write site.
    const cache = new TtlCache<string | null>({ ttlMs: 10_000 });
    let release: (v: string | null) => void = () => {};
    const started = cache.getOrLoad('key:nobody', () => new Promise((resolve) => (release = resolve)));
    cache.invalidateTag('partner:A');
    release(null);
    await started;
    expect(cache.get('key:nobody')).toBeNull();
  });
});
