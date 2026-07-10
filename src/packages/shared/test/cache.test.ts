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
