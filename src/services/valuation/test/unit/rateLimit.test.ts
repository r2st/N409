import { describe, expect, it } from 'vitest';
import {
  FixedWindowRateLimiter,
  SlidingWindowRateLimiter,
  WeightedWindowRateLimiter,
} from '../../src/plugins/rateLimit.js';

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

  // ── The map is sized by whoever is calling ────────────────────────────────
  //
  // These limiters key on `req.ip` on the public routes (contact, the three
  // portals, SCIM). That only became load-bearing when the services learned to
  // resolve the client through the proxy: before that `req.ip` was the peer
  // address, so the map held one key and no traffic could grow it. Now a caller
  // choosing distinct source addresses chooses the map size, which is the same
  // position SlidingWindowRateLimiter was already hardened for.

  it('does not rescan the whole map on every new key once it is crowded', () => {
    // The old sweep ran on every *new* key with no floor on the interval, and
    // found nothing to collect while the windows were still open — so past the
    // threshold each new caller paid a full scan and the map kept growing. The
    // ten-minute contact window is the worst case: nothing expires for ten
    // minutes, so the scan is pure waste for the whole of it.
    const limiter = new FixedWindowRateLimiter(5, 10 * 60_000, { sweepAtKeys: 10, maxKeys: 50_000 });
    for (let i = 0; i < 20; i += 1) limiter.check(`ip:${i}`, 0);
    const before = limiter.sweeps;
    for (let i = 0; i < 500; i += 1) limiter.check(`ip:x${i}`, 0);
    expect(limiter.sweeps - before).toBe(0);
  });

  it('still collects expired windows once the interval has passed', () => {
    // Throttling the sweep must not turn it off.
    const limiter = new FixedWindowRateLimiter(5, 60_000, { sweepAtKeys: 10 });
    for (let i = 0; i < 20; i += 1) limiter.check(`ip:${i}`, 0);
    expect(limiter.size).toBe(20);
    limiter.check('ip:later', 120_000);
    expect(limiter.size).toBe(1);
  });

  it('holds a hard ceiling when keys are minted faster than they expire', () => {
    // Every window is live for ten minutes, so the expiry sweep can free
    // nothing — this is the spray-distinct-addresses case, and without a
    // ceiling the map grows until the process dies.
    const limiter = new FixedWindowRateLimiter(5, 10 * 60_000, { sweepAtKeys: 10, maxKeys: 25 });
    for (let i = 0; i < 5_000; i += 1) limiter.check(`ip:${i}`, i);
    expect(limiter.size).toBeLessThanOrEqual(25);
  });

  it('evicts the idle keys, not the one the flood keeps touching', () => {
    // The eviction hands its victim a fresh window, so which key is chosen is
    // the whole question. A flood of one-shot addresses must not wash out the
    // entry that is tracking the flood — here, the shared key every one of
    // those requests also charges.
    const limiter = new FixedWindowRateLimiter(3, 10 * 60_000, { sweepAtKeys: 10, maxKeys: 20 });
    for (let i = 0; i < 3; i += 1) limiter.check('scim:shared', i);
    // Now spray far past the ceiling, touching the shared key throughout.
    for (let i = 0; i < 500; i += 1) {
      limiter.check(`ip:${i}`, 100 + i);
      limiter.check('scim:shared', 100 + i);
    }
    // Still refused: its window survived the spray rather than being reset.
    expect(limiter.check('scim:shared', 700).allowed).toBe(false);
  });

  it('never evicts the key the current call is about', () => {
    // Otherwise the ceiling becomes the bypass: overflow the map and the very
    // request being checked is handed a brand new window.
    const limiter = new FixedWindowRateLimiter(1, 10 * 60_000, { sweepAtKeys: 5, maxKeys: 1 });
    expect(limiter.check('ip:me', 0).allowed).toBe(true);
    expect(limiter.check('ip:me', 1).allowed).toBe(false);
    expect(limiter.check('ip:me', 2).allowed).toBe(false);
  });

  it('keeps a denied key hot so it is not shed as idle', () => {
    // A key that is currently refusing requests is the most important one in
    // the map. If the denied path did not touch it, LRU would read it as the
    // stalest entry — it stops being written to precisely when it starts
    // denying — and evicting it returns a fresh window to the caller being
    // refused.
    const limiter = new FixedWindowRateLimiter(1, 10 * 60_000, { sweepAtKeys: 100, maxKeys: 3 });
    limiter.check('ip:noisy', 0);
    expect(limiter.check('ip:noisy', 1).allowed).toBe(false);
    // Enough other traffic to cycle the ceiling many times over. The assertion
    // is that the refusal never lapses — checking only the *final* state would
    // pass even if the key were evicted and re-admitted along the way, since
    // the request that re-admits it opens a fresh window that the next one is
    // refused by. The bypass is the gap in the middle, not the end state.
    let admitted = 0;
    for (let i = 0; i < 50; i += 1) {
      limiter.check(`ip:other${i}`, 10 + i);
      if (limiter.check('ip:noisy', 10 + i).allowed) admitted += 1;
    }
    expect(admitted).toBe(0);
    expect(limiter.check('ip:noisy', 200).allowed).toBe(false);
  });
});

describe('WeightedWindowRateLimiter', () => {
  it('charges cost against the budget and refuses when it would overrun', () => {
    const limiter = new WeightedWindowRateLimiter(100, 60_000);
    expect(limiter.consume('u1', 60, 0)).toMatchObject({ allowed: true, remaining: 40 });
    expect(limiter.consume('u1', 60, 1)).toMatchObject({ allowed: false, remaining: 40 });
    // The refused request must not have been charged.
    expect(limiter.spent('u1', 1)).toBe(60);
  });

  it('admits a single request whose cost exceeds the whole budget', () => {
    // Documented behaviour: otherwise raising a route's cost past the budget
    // silently takes the route offline, which is the worse failure.
    const limiter = new WeightedWindowRateLimiter(10, 60_000);
    expect(limiter.consume('u1', 999, 0).allowed).toBe(true);
    expect(limiter.consume('u1', 1, 1).allowed).toBe(false);
  });

  it('resets the budget after the window elapses', () => {
    const limiter = new WeightedWindowRateLimiter(10, 1_000);
    expect(limiter.consume('u1', 10, 0).allowed).toBe(true);
    expect(limiter.consume('u1', 10, 999).allowed).toBe(false);
    expect(limiter.consume('u1', 10, 1_000).allowed).toBe(true);
    expect(limiter.spent('u1', 1_000)).toBe(10);
  });

  it('reports nothing spent once the window has passed', () => {
    const limiter = new WeightedWindowRateLimiter(10, 1_000);
    limiter.consume('u1', 7, 0);
    expect(limiter.spent('u1', 500)).toBe(7);
    expect(limiter.spent('u1', 1_000)).toBe(0);
  });

  it('bounds its map the same way, since it shares the mechanism', () => {
    const limiter = new WeightedWindowRateLimiter(100, 10 * 60_000, { sweepAtKeys: 10, maxKeys: 25 });
    for (let i = 0; i < 5_000; i += 1) limiter.consume(`u${i}`, 1, i);
    expect(limiter.size).toBeLessThanOrEqual(25);
  });

  it('does not let a spent() read reorder the eviction queue', () => {
    // `spent` is a diagnostic. If it touched the LRU order, reading the map
    // would change which key is dropped next — and it is called from tests and
    // instrumentation, not from the throttle decision.
    const limiter = new WeightedWindowRateLimiter(100, 10 * 60_000, { sweepAtKeys: 100, maxKeys: 2 });
    limiter.consume('first', 1, 0);
    limiter.consume('second', 1, 1);
    limiter.spent('first', 2); // would promote 'first' if it touched
    limiter.consume('third', 1, 3); // forces one eviction
    // 'first' was least recently *written*, so it is the one that goes.
    expect(limiter.spent('first', 4)).toBe(0);
    expect(limiter.spent('second', 4)).toBe(1);
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

  // ── The sweep is a full scan, and the attacker sizes the map ──────────────
  //
  // Sweeping per request made the limiter the amplifier. With the map pinned at
  // maxKeys, every allow() cost ~1.9ms of pure scanning; a login makes four
  // (two peeks, then two records on failure), so ~130 sign-in attempts a second
  // saturated the event loop — while the route's comment promises the throttle
  // runs "before any DB/scrypt work so a flood can't pin the CPU". Sustaining
  // it needed only enough distinct emails to keep the map full.

  it('does not rescan the whole map on every request once it is crowded', () => {
    const limiter = new SlidingWindowRateLimiter(10, 50_000, HOUR, 1_000);
    for (let i = 0; i < 50; i += 1) limiter.allow(`email:${i}`, 5, HOUR, undefined, 0);
    const before = limiter.sweeps;
    // 500 more requests in the same millisecond — the flood. Each one used to
    // walk every entry in the map.
    for (let i = 0; i < 500; i += 1) limiter.allow(`email:x${i}`, 5, HOUR, undefined, 0);
    expect(limiter.sweeps - before).toBe(0);
  });

  it('still sweeps a crowded map once the interval has passed', () => {
    // Throttling must not become "never": expired keys still have to go.
    const limiter = new SlidingWindowRateLimiter(10, 50_000, HOUR, 1_000);
    for (let i = 0; i < 50; i += 1) limiter.allow(`email:${i}`, 5, 60_000, undefined, 0);
    expect(limiter.size).toBe(50);
    limiter.allow('email:later', 5, 60_000, undefined, 120_000);
    expect(limiter.sweeps).toBeGreaterThan(0);
    expect(limiter.size).toBe(1); // the 50 expired entries were collected
  });

  it('holds the hard ceiling between sweeps, not only during one', () => {
    // Memory cannot wait for the next sweep: with eviction folded into the
    // throttled sweep, a burst inside one interval grows the map unchecked.
    const limiter = new SlidingWindowRateLimiter(10, 25, HOUR, 1_000);
    for (let i = 0; i < 500; i += 1) limiter.allow(`email:${i}`, 5, HOUR, undefined, 0);
    expect(limiter.size).toBeLessThanOrEqual(25);
  });

  it('evicts the idle keys, not the one the spray keeps touching', () => {
    // The shape of the real spray: credential stuffing from one source mints a
    // fresh `login:<email>` key per request, while `ip:<addr>` is checked by
    // every one of them. Those per-email keys are individually worthless — one
    // attempt each, never near their budget — and the per-IP entry is the only
    // throttle that can see the attack at all. LRU is what stops the emails
    // from washing it out: it is touched by every request, so it sits at the
    // back of the map while the eviction takes from the front.
    const limiter = new SlidingWindowRateLimiter(1_000, 10, HOUR, 1_000);
    let now = 0;
    for (let i = 0; i < 100; i += 1) {
      limiter.allow(`login:${i}`, 5, HOUR, undefined, (now += 1));
      limiter.allow('ip:1.2.3.4', 4, HOUR, undefined, now);
    }
    expect(limiter.size).toBeLessThanOrEqual(10); // the ceiling still held
    // Spent its budget on the 4th of a hundred requests and never got it back.
    expect(limiter.allow('ip:1.2.3.4', 4, HOUR, undefined, (now += 1))).toBe(false);
  });

  it('does evict a key that goes idle — LRU protects the touched, not the guilty', () => {
    // The honest limit of the policy above: recency is all the limiter knows,
    // so a key that stops being hit is indistinguishable from an abandoned one
    // and is shed like any other. That is the accepted cost of the ceiling —
    // worth stating outright so nobody reads LRU as a guarantee it isn't.
    const limiter = new SlidingWindowRateLimiter(1_000, 10, HOUR, 1_000);
    let now = 0;
    for (let i = 0; i < 5; i += 1) limiter.allow('went-quiet', 5, HOUR, undefined, (now += 1));
    expect(limiter.allow('went-quiet', 5, HOUR, undefined, (now += 1))).toBe(false);
    for (let i = 0; i < 100; i += 1) limiter.allow(`spray:${i}`, 5, HOUR, undefined, (now += 1));
    expect(limiter.allow('went-quiet', 5, HOUR, undefined, (now += 1))).toBe(true);
  });

  it('never evicts the key the current call is about', () => {
    // Dropping it here would reset the budget for the very request being
    // checked — the one case where a fresh budget is not an acceptable trade.
    const limiter = new SlidingWindowRateLimiter(1_000, 1, HOUR, 1_000);
    let now = 0;
    expect(limiter.allow('k', 1, HOUR, undefined, (now += 1))).toBe(true);
    expect(limiter.allow('k', 1, HOUR, undefined, (now += 1))).toBe(false);
  });
});

/**
 * The number a refused caller is told to wait.
 *
 * `allow()` returns a boolean, and every 429 on the unauthenticated auth
 * surface was raised from one — with no second argument, so no `retry-after`
 * header and no `retry_after_seconds` in the body. The published catalogue
 * meanwhile tells the caller to "wait the stated number of seconds — not a
 * fixed timer of your own", which on a fifteen-minute window is precisely the
 * advice that cannot be followed without this.
 */
describe('SlidingWindowRateLimiter.retryAfterSeconds', () => {
  const MINUTE = 60 * 1000;

  it('is zero while the key still has headroom', () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.retryAfterSeconds('k', 2, MINUTE, 0)).toBe(0);
    limiter.allow('k', 2, MINUTE, undefined, 0);
    expect(limiter.retryAfterSeconds('k', 2, MINUTE, 0)).toBe(0);
  });

  it('counts from the oldest hit still inside the window, not from now', () => {
    // A sliding window frees exactly one slot at a time, and the slot that
    // frees next is the head of the list. Two hits at t=0 and t=30s against a
    // 60s window: the caller is back in at t=60s, thirty seconds from the
    // second hit — not sixty.
    const limiter = new SlidingWindowRateLimiter();
    limiter.allow('k', 2, MINUTE, undefined, 0);
    limiter.allow('k', 2, MINUTE, undefined, 30_000);
    expect(limiter.retryAfterSeconds('k', 2, MINUTE, 30_000)).toBe(30);
  });

  it('never says zero to a caller it is refusing', () => {
    // A window that expires in under a second still has to round up: telling a
    // refused client to retry immediately is how a backoff loop becomes a spin.
    const limiter = new SlidingWindowRateLimiter();
    limiter.allow('k', 1, MINUTE, undefined, 0);
    expect(limiter.allow('k', 1, MINUTE, undefined, MINUTE - 1)).toBe(false);
    expect(limiter.retryAfterSeconds('k', 1, MINUTE, MINUTE - 1)).toBe(1);
  });

  it('agrees with the limiter about when the caller is let back in', () => {
    // The property that matters: wait exactly what you were told, and the next
    // request is allowed. Checked across a few limits rather than asserted once.
    for (const limit of [1, 3, 10]) {
      const limiter = new SlidingWindowRateLimiter();
      let now = 0;
      for (let i = 0; i < limit; i += 1) limiter.allow(`k${limit}`, limit, MINUTE, undefined, (now += 1_000));
      expect(limiter.allow(`k${limit}`, limit, MINUTE, { peek: true }, now)).toBe(false);
      const wait = limiter.retryAfterSeconds(`k${limit}`, limit, MINUTE, now);
      expect(wait, `limit ${limit}`).toBeGreaterThan(0);
      expect(limiter.allow(`k${limit}`, limit, MINUTE, { peek: true }, now + wait * 1_000)).toBe(true);
    }
  });

  it('forgets a key whose window has passed', () => {
    const limiter = new SlidingWindowRateLimiter();
    limiter.allow('k', 1, MINUTE, undefined, 0);
    expect(limiter.retryAfterSeconds('k', 1, MINUTE, 0)).toBe(60);
    expect(limiter.retryAfterSeconds('k', 1, MINUTE, MINUTE)).toBe(0);
  });
});
