/**
 * Per-API-key rate limiting for the partner API (improvement 6). Fixed-window
 * counters in process memory — the deployment is a single host/process, so
 * there is no shared-state problem; if that changes this moves to Redis.
 *
 * NOTE (P2-1): This in-memory limiter is only correct for a single-process/
 * single-box deployment. Before scaling horizontally (multiple app instances
 * behind a load balancer), move the counters to a shared store such as Redis
 * so limits are enforced across the whole fleet rather than per process.
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window (0 when denied). */
  remaining: number;
  /** Epoch millis when the current window resets. */
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitResult {
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      this.sweep(now);
      return { allowed: true, limit: this.limit, remaining: this.limit - 1, resetAt: now + this.windowMs };
    }

    const resetAt = window.start + this.windowMs;
    if (window.count >= this.limit) {
      return { allowed: false, limit: this.limit, remaining: 0, resetAt };
    }
    window.count += 1;
    return { allowed: true, limit: this.limit, remaining: this.limit - window.count, resetAt };
  }

  /** Drop expired windows so idle keys don't accumulate forever. */
  private sweep(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

/**
 * Fixed-window limiter over a *cost budget* rather than a request count, for
 * the expensive routes classified in domain/requestCost.ts. One PDF render can
 * cost as much as thirty list calls, so charging both a single "request" lets a
 * user stay inside the session limit while still saturating the box.
 *
 * A request whose cost exceeds the whole budget is still admitted once per
 * window — otherwise raising a route's cost past the budget would silently take
 * the route offline, which is a worse failure than letting one through.
 */
export class WeightedWindowRateLimiter {
  private windows = new Map<string, { start: number; spent: number }>();

  constructor(
    /** Cost units available per window. */
    readonly budget: number,
    readonly windowMs: number,
  ) {}

  /** Charge `cost` units to `key`. `remaining` is budget left, not requests. */
  consume(key: string, cost: number, now: number = Date.now()): RateLimitResult {
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      this.windows.set(key, { start: now, spent: cost });
      this.sweep(now);
      return {
        allowed: true,
        limit: this.budget,
        remaining: Math.max(0, this.budget - cost),
        resetAt: now + this.windowMs,
      };
    }

    const resetAt = window.start + this.windowMs;
    if (window.spent + cost > this.budget) {
      return {
        allowed: false,
        limit: this.budget,
        remaining: Math.max(0, this.budget - window.spent),
        resetAt,
      };
    }
    window.spent += cost;
    return {
      allowed: true,
      limit: this.budget,
      remaining: Math.max(0, this.budget - window.spent),
      resetAt,
    };
  }

  /** Units already spent in the current window — for tests and diagnostics. */
  spent(key: string, now: number = Date.now()): number {
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) return 0;
    return window.spent;
  }

  private sweep(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

/**
 * Sliding-window limiter for the unauthenticated auth routes. Unlike
 * FixedWindowRateLimiter the limit and window are supplied per call, because a
 * single instance backs a dozen different throttles (per-IP register, per-email
 * login, per-user MFA…) each with its own budget.
 *
 * Eviction is not optional here. Every key is derived from attacker-controlled
 * input — `register-ip:<ip>`, `login:<email>` — so an unbounded Map is a remote
 * OOM: spray distinct emails or spoofed XFF values and the process grows until
 * it dies. Three mechanisms keep it bounded:
 *
 *  1. Per-entry expiry. An entry is dead once its longest window has passed, so
 *     a sweep can drop it without consulting the caller's limit.
 *  2. A sweep triggered by size *or* elapsed time, so both a burst of keys and
 *     a slow trickle over a long uptime get collected.
 *  3. A hard key ceiling. If a sweep can't get under it — an attacker minting
 *     keys faster than they expire — the entries closest to expiring are
 *     dropped anyway. That does hand those keys a fresh budget, which is the
 *     right trade: a spray across millions of distinct keys is not the attack
 *     the per-key limit defends against, and staying alive matters more.
 */
export interface SlidingWindowOptions {
  /** Report headroom without consuming it (caller records the hit itself). */
  peek?: boolean;
}

export class SlidingWindowRateLimiter {
  /** key → hit timestamps (ascending) plus when the entry stops mattering. */
  private hits = new Map<string, { times: number[]; expiresAt: number }>();
  private lastSweep = 0;

  constructor(
    /** Sweep once the map reaches this many keys. */
    private readonly sweepAtKeys = 5_000,
    /** Never hold more than this many keys, expired or not. */
    private readonly maxKeys = 50_000,
    /** Force a sweep at least this often, however few keys there are. */
    private readonly sweepEveryMs = 60 * 60 * 1000,
  ) {}

  /** True when the request is within `limit` per `windowMs` for this key. */
  allow(
    key: string,
    limit: number,
    windowMs: number,
    opts?: SlidingWindowOptions,
    now: number = Date.now(),
  ): boolean {
    this.maybeSweep(now, key);
    const entry = this.hits.get(key);
    const times = (entry?.times ?? []).filter((t) => now - t < windowMs);

    if (times.length >= limit) {
      // Keep the pruned list — it is strictly smaller than what we read.
      this.store(key, times, now, windowMs, entry?.expiresAt);
      return false;
    }
    if (!opts?.peek) times.push(now);
    this.store(key, times, now, windowMs, entry?.expiresAt);
    return true;
  }

  /** Number of tracked keys — for tests and diagnostics. */
  get size(): number {
    return this.hits.size;
  }

  /**
   * A peek that recorded nothing leaves no state behind, so it must not create
   * a key: otherwise merely *probing* the limiter (which every login attempt
   * does, twice) allocates an entry per IP and per email.
   */
  private store(
    key: string,
    times: number[],
    now: number,
    windowMs: number,
    priorExpiry: number | undefined,
  ): void {
    if (times.length === 0) {
      this.hits.delete(key);
      return;
    }
    // The same key can be checked against different windows; the entry lives
    // until the longest of them could no longer exclude a request.
    const expiresAt = Math.max(now + windowMs, priorExpiry ?? 0);
    this.hits.set(key, { times, expiresAt });
  }

  private maybeSweep(now: number, incomingKey: string): void {
    if (this.hits.size < this.sweepAtKeys && now - this.lastSweep < this.sweepEveryMs) return;
    this.lastSweep = now;
    for (const [key, entry] of this.hits) {
      if (entry.expiresAt <= now) this.hits.delete(key);
    }
    // Leave room for the key this call is about to write, so `maxKeys` is a
    // ceiling on the map rather than on the map-before-the-insert.
    const ceiling = Math.max(0, this.maxKeys - (this.hits.has(incomingKey) ? 0 : 1));
    if (this.hits.size <= ceiling) return;
    // Still over: shed the entries with the least life left.
    const byExpiry = [...this.hits.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [key] of byExpiry.slice(0, this.hits.size - ceiling)) this.hits.delete(key);
  }
}
