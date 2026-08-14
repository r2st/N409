import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPartnerLogoCache,
  fetchPartnerLogoCached,
  partnerLogoCacheSize,
} from '../../src/clients/partnerLogoCache.js';
import type { fetchPartnerLogo } from '../../src/clients/partnerLogo.js';

/** The fetcher signature the cache delegates to. */
type LogoFetcher = typeof fetchPartnerLogo;

/**
 * The logo fetch sits on the critical path of every report render, and it is a
 * DNS lookup plus an HTTP GET for bytes that do not change between renders.
 * These tests pin the two properties that make the cache worth having: it does
 * not re-fetch within the window, and it does not hold anything forever.
 */

const PNG = Buffer.from('\x89PNG\r\n\x1a\nlogo', 'latin1');
const URL_A = 'https://cdn.partner.example/logo.png';
const URL_B = 'https://cdn.other.example/mark.png';

/** A stub logo fetcher that counts calls, matching fetchPartnerLogo's shape. */
function stub(result: Buffer | null = PNG) {
  return vi.fn(async () => result) as unknown as LogoFetcher;
}

describe('partner logo cache', () => {
  afterEach(() => clearPartnerLogoCache());

  it('fetches once and serves the same bytes to later renders', async () => {
    const fetchLogo = stub();
    const clock = () => 1_000;

    const first = await fetchPartnerLogoCached(URL_A, clock, fetchLogo);
    const second = await fetchPartnerLogoCached(URL_A, clock, fetchLogo);
    const third = await fetchPartnerLogoCached(URL_A, clock, fetchLogo);

    expect(first).toEqual(PNG);
    expect(second).toEqual(PNG);
    expect(third).toEqual(PNG);
    expect(fetchLogo).toHaveBeenCalledTimes(1);
  });

  it('keys on the URL, so two partners do not share a logo', async () => {
    const other = Buffer.from('\x89PNG\r\n\x1a\nother', 'latin1');
    const fetchLogo = vi.fn(async (url: string | null) =>
      url === URL_A ? PNG : other,
    ) as unknown as LogoFetcher;

    expect(await fetchPartnerLogoCached(URL_A, () => 1_000, fetchLogo)).toEqual(PNG);
    expect(await fetchPartnerLogoCached(URL_B, () => 1_000, fetchLogo)).toEqual(other);
    expect(partnerLogoCacheSize()).toBe(2);
  });

  it('re-fetches once the entry has aged out, so a new logo lands', async () => {
    const fetchLogo = stub();
    await fetchPartnerLogoCached(URL_A, () => 0, fetchLogo);
    // Inside the window: still one fetch.
    await fetchPartnerLogoCached(URL_A, () => 59_000, fetchLogo);
    expect(fetchLogo).toHaveBeenCalledTimes(1);
    // Past it: a partner who swapped their logo gets the new one.
    await fetchPartnerLogoCached(URL_A, () => 61_000, fetchLogo);
    expect(fetchLogo).toHaveBeenCalledTimes(2);
  });

  it('caches a failure too, so a dead URL cannot cost every render a timeout', async () => {
    const fetchLogo = stub(null);

    expect(await fetchPartnerLogoCached(URL_A, () => 0, fetchLogo)).toBeNull();
    expect(await fetchPartnerLogoCached(URL_A, () => 5_000, fetchLogo)).toBeNull();
    expect(fetchLogo).toHaveBeenCalledTimes(1);
  });

  it('retries a failure sooner than it refreshes a success', async () => {
    const fetchLogo = stub(null);
    await fetchPartnerLogoCached(URL_A, () => 0, fetchLogo);
    // A fixed URL must recover in seconds, not in the full success TTL.
    await fetchPartnerLogoCached(URL_A, () => 11_000, fetchLogo);
    expect(fetchLogo).toHaveBeenCalledTimes(2);
  });

  it('returns null for a partner with no logo without touching the cache', async () => {
    const fetchLogo = stub();
    expect(await fetchPartnerLogoCached(null, () => 0, fetchLogo)).toBeNull();
    expect(fetchLogo).not.toHaveBeenCalled();
    expect(partnerLogoCacheSize()).toBe(0);
  });

  it('can be flushed', async () => {
    const fetchLogo = stub();
    await fetchPartnerLogoCached(URL_A, () => 0, fetchLogo);
    clearPartnerLogoCache();
    expect(partnerLogoCacheSize()).toBe(0);
    await fetchPartnerLogoCached(URL_A, () => 0, fetchLogo);
    expect(fetchLogo).toHaveBeenCalledTimes(2);
  });

  // ── Concurrent renders ────────────────────────────────────────────────────
  //
  // A cache with no in-flight map only ever helps the *second* render, and the
  // workload this cache exists for — a firm re-rendering a batch of reports —
  // issues them together. Every one of them missed the cold entry and ran its
  // own DNS lookup and HTTP GET for the same image.

  it('collapses concurrent cold renders into one fetch', async () => {
    let release: (logo: Buffer) => void = () => {};
    const fetchLogo = vi.fn(
      () => new Promise<Buffer>((resolve) => (release = resolve)),
    ) as unknown as LogoFetcher;

    // Ten reports rendering at once, none of them yet resolved.
    const renders = Array.from({ length: 10 }, () =>
      fetchPartnerLogoCached(URL_A, () => 0, fetchLogo),
    );
    expect(fetchLogo).toHaveBeenCalledTimes(1);

    release(PNG);
    expect(await Promise.all(renders)).toEqual(Array.from({ length: 10 }, () => PNG));
    expect(fetchLogo).toHaveBeenCalledTimes(1);
    expect(partnerLogoCacheSize()).toBe(1);
  });

  it('keeps concurrent renders for different partners apart', async () => {
    const other = Buffer.from('\x89PNG\r\n\x1a\nother', 'latin1');
    const fetchLogo = vi.fn(async (url: string | null) =>
      url === URL_A ? PNG : other,
    ) as unknown as LogoFetcher;

    const [a, b] = await Promise.all([
      fetchPartnerLogoCached(URL_A, () => 0, fetchLogo),
      fetchPartnerLogoCached(URL_B, () => 0, fetchLogo),
    ]);
    expect(a).toEqual(PNG);
    expect(b).toEqual(other);
    expect(fetchLogo).toHaveBeenCalledTimes(2);
  });

  it('does not cache a thrown fetch, and lets the next render retry', async () => {
    const boom = new Error('DNS exploded');
    const fetchLogo = vi.fn(async () => {
      throw boom;
    }) as unknown as LogoFetcher;

    await expect(fetchPartnerLogoCached(URL_A, () => 0, fetchLogo)).rejects.toThrow(boom);
    // The slot is cleared on rejection, so a transient failure cannot wedge
    // the URL for the life of the process.
    expect(partnerLogoCacheSize()).toBe(0);
    await expect(fetchPartnerLogoCached(URL_A, () => 0, fetchLogo)).rejects.toThrow(boom);
    expect(fetchLogo).toHaveBeenCalledTimes(2);
  });

  it('counts the TTL from when the fetch settled, not from when it started', async () => {
    const fetchLogo = stub();
    let clock = 0;
    // A slow host: the call starts at 0 and returns at 30s.
    const slow = vi.fn(async () => {
      clock = 30_000;
      return PNG;
    }) as unknown as LogoFetcher;

    await fetchPartnerLogoCached(URL_A, () => clock, slow);
    // 80s on the wall is 50s after the bytes arrived — still inside the window.
    clock = 80_000;
    await fetchPartnerLogoCached(URL_A, () => clock, fetchLogo);
    expect(fetchLogo).not.toHaveBeenCalled();
  });

  // ── Bounding ──────────────────────────────────────────────────────────────
  //
  // The key is the URL, not the partner, so a logo swap mints a new key and
  // the superseded one used to stay for the life of the process: expired
  // entries were skipped on read and never removed.

  it('holds a bounded number of URLs however many it is shown', async () => {
    const fetchLogo = stub();
    for (let i = 0; i < 700; i++) {
      await fetchPartnerLogoCached(`https://cdn.example/logo-${i}.png`, () => 0, fetchLogo);
    }
    expect(fetchLogo).toHaveBeenCalledTimes(700);
    expect(partnerLogoCacheSize()).toBeLessThanOrEqual(512);
  });

  it('evicts the entries nobody has asked for, keeping the ones in use', async () => {
    const fetchLogo = stub();
    // URL_A is fetched first, then touched again after every twentieth
    // newcomer — the shape of one busy partner amid a churn of one-offs.
    await fetchPartnerLogoCached(URL_A, () => 0, fetchLogo);
    for (let i = 0; i < 600; i++) {
      await fetchPartnerLogoCached(`https://cdn.example/churn-${i}.png`, () => 0, fetchLogo);
      if (i % 20 === 0) await fetchPartnerLogoCached(URL_A, () => 0, fetchLogo);
    }
    const before = (fetchLogo as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    // Still cached: LRU keeps what is being used rather than what arrived first.
    expect(await fetchPartnerLogoCached(URL_A, () => 0, fetchLogo)).toEqual(PNG);
    expect((fetchLogo as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
  });

  it('drops expired entries first, so live ones are not evicted for dead weight', async () => {
    const fetchLogo = stub();
    // Fill past the ceiling with entries that are all stale by the time the
    // last one lands (the hit TTL is 60s).
    for (let i = 0; i < 512; i++) {
      await fetchPartnerLogoCached(`https://cdn.example/old-${i}.png`, () => 0, fetchLogo);
    }
    await fetchPartnerLogoCached(URL_A, () => 120_000, fetchLogo);
    // The expired 512 are collected rather than one live entry being pushed
    // out to make room for another.
    expect(partnerLogoCacheSize()).toBe(1);
  });
});
