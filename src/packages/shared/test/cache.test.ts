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

  it('evicts the least recently written entries beyond maxEntries', () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
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
