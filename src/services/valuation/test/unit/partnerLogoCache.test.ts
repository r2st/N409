import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPartnerLogoCache,
  fetchPartnerLogoCached,
  partnerLogoCacheSize,
} from '../../src/clients/partnerLogoCache.js';

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
  return vi.fn(async () => result) as unknown as typeof import('../../src/clients/partnerLogo.js').fetchPartnerLogo;
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
    ) as unknown as typeof import('../../src/clients/partnerLogo.js').fetchPartnerLogo;

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
});
