/**
 * Per-API-key rate limiting for the partner API (improvement 6). Fixed-window
 * counters in process memory — the deployment is a single host/process, so
 * there is no shared-state problem; if that changes this moves to Redis.
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
