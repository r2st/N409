import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, SlidingWindowRateLimiter } from '../../src/plugins/rateLimit.js';

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

/**
 * Sliding window limiter — backs the unauthenticated auth routes. Keys embed
 * request-supplied IPs and email addresses, so the eviction behaviour below is
 * the fix for a remote OOM, not a tidiness measure.
 */
describe('SlidingWindowRateLimiter', () => {
  const HOUR = 60 * 60 * 1000;

  it('allows up to the limit within the window, then denies', () => {
    const limiter = new SlidingWindowRateLimiter();
    const t0 = 1_000_000;
    expect(limiter.allow('k', 2, HOUR, undefined, t0)).toBe(true);
    expect(limiter.allow('k', 2, HOUR, undefined, t0 + 1)).toBe(true);
    expect(limiter.allow('k', 2, HOUR, undefined, t0 + 2)).toBe(false);
  });

  it('slides: a hit older than the window stops counting', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.allow('k', 1, 1_000, undefined, 0)).toBe(true);
    expect(limiter.allow('k', 1, 1_000, undefined, 999)).toBe(false);
    expect(limiter.allow('k', 1, 1_000, undefined, 1_000)).toBe(true);
  });

  it('peek reports headroom without consuming it', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.allow('k', 1, HOUR, { peek: true }, 0)).toBe(true);
    expect(limiter.allow('k', 1, HOUR, { peek: true }, 1)).toBe(true);
    // ...and a peek that records nothing must not allocate an entry, or every
    // login attempt would leak a key per IP and per email.
    expect(limiter.size).toBe(0);
    expect(limiter.allow('k', 1, HOUR, undefined, 2)).toBe(true);
    expect(limiter.allow('k', 1, HOUR, { peek: true }, 3)).toBe(false);
  });

  it('tracks keys independently', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.allow('a', 1, HOUR, undefined, 0)).toBe(true);
    expect(limiter.allow('b', 1, HOUR, undefined, 0)).toBe(true);
    expect(limiter.allow('a', 1, HOUR, undefined, 1)).toBe(false);
  });

  it('evicts expired keys once the sweep threshold is crossed', () => {
    // sweepAtKeys=10 so the test does not need to mint thousands of entries.
    const limiter = new SlidingWindowRateLimiter(10, 1_000, HOUR);
    for (let i = 0; i < 20; i += 1) limiter.allow(`ip:${i}`, 5, 60_000, undefined, 0);
    expect(limiter.size).toBe(20);
    // An hour later every one of those windows is long dead.
    limiter.allow('ip:fresh', 5, 60_000, undefined, HOUR);
    expect(limiter.size).toBe(1);
  });

  it('sweeps on elapsed time even when the key count stays low', () => {
    const limiter = new SlidingWindowRateLimiter(10_000, 50_000, 1_000);
    limiter.allow('ip:1', 5, 500, undefined, 0);
    expect(limiter.size).toBe(1);
    limiter.allow('ip:2', 5, 500, undefined, 2_000);
    expect(limiter.size).toBe(1); // ip:1 collected despite only 2 keys total
  });

  it('enforces a hard ceiling when keys are minted faster than they expire', () => {
    // Every key is live for an hour, so the expiry sweep can free nothing —
    // this is the spray-distinct-emails case that used to grow without bound.
    const limiter = new SlidingWindowRateLimiter(10, 10, HOUR);
    for (let i = 0; i < 200; i += 1) limiter.allow(`email:${i}`, 5, HOUR, undefined, i);
    expect(limiter.size).toBeLessThanOrEqual(10);
  });

  it('does not let a short-window check expire an entry a long window still needs', () => {
    // Entry retention is driven by the longest window the key has been checked
    // against, so an aggressive sweep cannot drop live state. (Pruning of the
    // hit list itself is per-window — each call filters to its own window — so
    // a key must not be shared between throttles with different budgets. The
    // auth routes key every throttle by its own prefix, which is what keeps
    // that safe.)
    const limiter = new SlidingWindowRateLimiter(1, 50_000, 1);
    limiter.allow('ip:1', 5, HOUR, undefined, 0); // hour-long window
    limiter.allow('ip:1', 5, 1_000, undefined, 1); // …and a short one
    // A sweep 2s later must not drop the entry: the hour window still binds.
    limiter.allow('ip:1', 5, 1_000, undefined, 2_000);
    expect(limiter.size).toBe(1);
  });
});
