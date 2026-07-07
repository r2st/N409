import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../../src/plugins/rateLimit.js';

/** Improvement 6 — per-API-key rate limiting for the partner API. */

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit within a window, then denies', () => {
    const limiter = new FixedWindowRateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.check('key', t0)).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.check('key', t0 + 1)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check('key', t0 + 2)).toMatchObject({ allowed: true, remaining: 0 });
    const denied = limiter.check('key', t0 + 3);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.resetAt).toBe(t0 + 60_000);
  });

  it('resets after the window elapses', () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000);
    const t0 = 5_000;
    expect(limiter.check('key', t0).allowed).toBe(true);
    expect(limiter.check('key', t0 + 999).allowed).toBe(false);
    expect(limiter.check('key', t0 + 1_000).allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    const t0 = 0;
    expect(limiter.check('a', t0).allowed).toBe(true);
    expect(limiter.check('b', t0).allowed).toBe(true);
    expect(limiter.check('a', t0 + 1).allowed).toBe(false);
    expect(limiter.check('b', t0 + 1).allowed).toBe(false);
  });

  it('reports the reset boundary of the active window', () => {
    const limiter = new FixedWindowRateLimiter(2, 10_000);
    const first = limiter.check('key', 100);
    expect(first.resetAt).toBe(10_100);
    // second request later in the same window keeps the original boundary
    expect(limiter.check('key', 5_000).resetAt).toBe(10_100);
  });
});
