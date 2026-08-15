/**
 * Who is holding the connections, and for how long.
 *
 * `index.ts` has published `totalCount`, `idleCount` and `waitingCount` as
 * gauges since B-3, and those three numbers say a pool is in trouble without
 * ever saying why. A `waitingCount` pinned at 12 is the same reading whether
 * the database is slow, a route is running one enormous query, or some path
 * checked out a client and never gave it back — and those want completely
 * different responses. The third one is also the only one that never recovers
 * on its own: a leaked client is gone for the life of the process, so a leak
 * that happens once per hundred requests takes a pool of ten down after a
 * thousand, and does it so gradually that the graph looks like organic growth.
 *
 * The pool's own timeouts do not catch it. `idleTimeoutMillis` only reaps
 * clients that are *idle in the pool*, and a leaked client is checked out, not
 * idle. `idle_in_transaction_session_timeout` catches a leak that left a
 * transaction open, which is the polite kind; a client checked out, used for a
 * plain SELECT and never released has no open transaction and sits there
 * forever, entirely healthy as far as Postgres is concerned.
 *
 * So this tracks checkouts directly:
 *
 *  - every `pool.connect()` records when it happened and the stack that asked;
 *  - `release()` clears the record;
 *  - anything still outstanding after `leakAfterMs` is reported, with that
 *    stack, which is the one piece of information that turns "the pool is
 *    exhausted" into a file and a line number.
 *
 * The stack is captured on every checkout, which is not free — it is one
 * `Error` construction per acquisition, and `pool.query()` is an acquisition.
 * `captureStacks` exists to turn it off, but it defaults on: a leak that is
 * only reproducible in production is exactly the leak this is for, and a report
 * that says a connection leaked without saying from where costs more
 * engineer-hours than the allocation ever costs CPU.
 */

import type pg from 'pg';

export interface PoolHealthLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface PoolHealthOptions {
  /** The pool's configured `max`, which saturation is measured against. */
  max: number;
  /**
   * A checkout still outstanding after this long is reported as a suspected
   * leak (ms). Comfortably above the 15s `statement_timeout`, because a
   * long-but-legitimate transaction running several statements is not a leak
   * and must not be reported as one — a leak detector that cries wolf gets
   * turned off, and then it is not a leak detector.
   */
  leakAfterMs?: number;
  /**
   * The pool is called exhausted once every client is checked out *and*
   * somebody is queued behind them for at least this long (ms). The dwell time
   * is what separates a saturated pool from a busy one: at any instant a
   * healthy service under load has callers waiting, and alerting on that
   * instant alerts constantly.
   */
  exhaustedAfterMs?: number;
  /** Injectable clock, so tests need no elapsed time. */
  now?: () => number;
  /** Cap on tracked checkouts, so the tracker can never be the leak. */
  maxTracked?: number;
  /** Capture an acquisition stack per checkout. See the header note. */
  captureStacks?: boolean;
}

/** One outstanding checkout. */
interface Checkout {
  id: number;
  since: number;
  stack: string | null;
  /** Already reported, so a leak is logged once rather than every sample. */
  reported: boolean;
}

export interface PoolSnapshot {
  /** Clients the pool holds: in use + idle. */
  total: number;
  idle: number;
  /** Callers queued for a client. */
  waiting: number;
  max: number;
  /** Checked-out clients this module is tracking. */
  checkedOut: number;
  /** 0–1: how much of the pool is in use. */
  saturation: number;
  /** Outstanding longer than `leakAfterMs`. */
  suspectedLeaks: number;
  /** Milliseconds the pool has been continuously exhausted; 0 when it is not. */
  exhaustedForMs: number;
  /** Age of the oldest outstanding checkout (ms), or 0 when there are none. */
  oldestCheckoutMs: number;
  /** Checkouts that were never released, cumulative since boot. */
  leaksDetected: number;
}

export interface LeakReport {
  id: number;
  heldMs: number;
  stack: string | null;
}

export interface PoolFindings {
  snapshot: PoolSnapshot;
  /** Newly-detected leaks — reported once each, not on every sample. */
  leaks: LeakReport[];
  /** True on the sample where exhaustion crosses the dwell threshold. */
  exhausted: boolean;
}

/**
 * Tracks checkouts against one pool. Constructed by {@link monitorPool}, which
 * is what actually attaches it.
 */
export class PoolHealth {
  private readonly outstanding = new Map<number, Checkout>();
  private nextId = 1;
  private leaksDetected = 0;
  /** When the pool most recently became fully saturated with callers queued. */
  private exhaustedSince: number | null = null;
  /** True while the current exhaustion episode has already been reported. */
  private exhaustionReported = false;

  private readonly max: number;
  private readonly leakAfterMs: number;
  private readonly exhaustedAfterMs: number;
  private readonly maxTracked: number;
  private readonly captureStacks: boolean;
  private readonly now: () => number;

  constructor(
    private readonly pool: Pick<pg.Pool, 'totalCount' | 'idleCount' | 'waitingCount'>,
    opts: PoolHealthOptions,
  ) {
    this.max = Math.max(1, opts.max);
    this.leakAfterMs = opts.leakAfterMs ?? 60_000;
    this.exhaustedAfterMs = opts.exhaustedAfterMs ?? 5_000;
    this.maxTracked = opts.maxTracked ?? 1_000;
    this.captureStacks = opts.captureStacks ?? true;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Register a checkout; returns the id to hand back to {@link released}.
   *
   * Bounded: past `maxTracked` outstanding entries this stops recording rather
   * than growing, and returns null. That ceiling is far above a healthy pool's
   * `max`, so reaching it means the tracking itself has gone wrong — at which
   * point refusing to allocate is the only behaviour that does not turn a
   * diagnostic into an outage of its own.
   */
  acquired(): number | null {
    if (this.outstanding.size >= this.maxTracked) return null;
    const id = this.nextId++;
    this.outstanding.set(id, {
      id,
      since: this.now(),
      // `Error.stack` rather than `captureStackTrace`: the latter is V8-only
      // and this also runs under vitest's transforms.
      stack: this.captureStacks ? (new Error('pool checkout').stack ?? null) : null,
      reported: false,
    });
    return id;
  }

  /** Deregister a checkout. Safe to call twice — a double release is not an error here. */
  released(id: number | null): void {
    if (id === null) return;
    this.outstanding.delete(id);
  }

  /**
   * Take a reading, and report anything newly wrong.
   *
   * Called on a timer. Reports each leak once (the `reported` flag) and each
   * exhaustion episode once, because the alternative is a log line per sample
   * for as long as the condition lasts, which buries the onset — and the onset
   * is the only part with diagnostic value.
   */
  sample(): PoolFindings {
    const at = this.now();
    const leaks: LeakReport[] = [];
    let oldest = 0;

    for (const checkout of this.outstanding.values()) {
      const heldMs = at - checkout.since;
      if (heldMs > oldest) oldest = heldMs;
      if (heldMs >= this.leakAfterMs && !checkout.reported) {
        checkout.reported = true;
        this.leaksDetected += 1;
        leaks.push({ id: checkout.id, heldMs, stack: checkout.stack });
      }
    }

    const total = this.pool.totalCount;
    const idle = this.pool.idleCount;
    const waiting = this.pool.waitingCount;

    // Exhausted: the pool is at its ceiling, nothing is idle, and somebody is
    // queued. All three, because any one of them alone is ordinary — a pool at
    // `max` with idle clients is a pool that grew and is now quiet.
    const saturatedNow = total >= this.max && idle === 0 && waiting > 0;
    if (saturatedNow) {
      this.exhaustedSince ??= at;
    } else {
      this.exhaustedSince = null;
      this.exhaustionReported = false;
    }
    const exhaustedForMs = this.exhaustedSince === null ? 0 : at - this.exhaustedSince;
    const exhausted =
      this.exhaustedSince !== null && exhaustedForMs >= this.exhaustedAfterMs && !this.exhaustionReported;
    if (exhausted) this.exhaustionReported = true;

    return {
      snapshot: {
        total,
        idle,
        waiting,
        max: this.max,
        checkedOut: this.outstanding.size,
        saturation: Math.min(1, (total - idle) / this.max),
        suspectedLeaks: [...this.outstanding.values()].filter((c) => c.reported).length,
        exhaustedForMs,
        oldestCheckoutMs: oldest,
        leaksDetected: this.leaksDetected,
      },
      leaks,
      exhausted,
    };
  }

  /** Snapshot without the reporting side effects — for gauges and the ops route. */
  peek(): PoolSnapshot {
    const at = this.now();
    let oldest = 0;
    let suspected = 0;
    for (const checkout of this.outstanding.values()) {
      const heldMs = at - checkout.since;
      if (heldMs > oldest) oldest = heldMs;
      if (heldMs >= this.leakAfterMs) suspected += 1;
    }
    const total = this.pool.totalCount;
    const idle = this.pool.idleCount;
    return {
      total,
      idle,
      waiting: this.pool.waitingCount,
      max: this.max,
      checkedOut: this.outstanding.size,
      saturation: Math.min(1, (total - idle) / this.max),
      suspectedLeaks: suspected,
      exhaustedForMs: this.exhaustedSince === null ? 0 : at - this.exhaustedSince,
      oldestCheckoutMs: oldest,
      leaksDetected: this.leaksDetected,
    };
  }
}

/** Marker so a pool is never instrumented twice. */
const MONITORED = Symbol('n409.poolHealth.monitored');

/**
 * Attach checkout tracking to a pool.
 *
 * Wraps `pool.connect` rather than listening on the `acquire`/`release` events,
 * because those events do not identify *which* checkout they refer to — they
 * hand you the client, and the same physical client is checked out and released
 * thousands of times. Wrapping the call is what lets a release be tied back to
 * the acquisition it belongs to, and the acquisition is where the stack is.
 *
 * `pool.query()` is implemented as connect-query-release inside pg, so this
 * covers ordinary queries and explicit `withTransaction` checkouts alike —
 * the same reasoning as `instrumentPool` in queryStats.ts, one layer up.
 */
export function monitorPool(pool: pg.Pool, opts: PoolHealthOptions): PoolHealth {
  const health = new PoolHealth(pool, opts);
  const tracked = pool as pg.Pool & { [MONITORED]?: boolean };
  if (tracked[MONITORED]) return health;
  tracked[MONITORED] = true;

  const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;

  (pool as { connect: unknown }).connect = function connect(...args: unknown[]) {
    // The callback form. pg supports both; the promise form is what this
    // codebase uses, but leaving the callback form untracked would make the
    // tracker silently partial the moment anything reached for it.
    const callback = args[0];
    if (typeof callback === 'function') {
      const cb = callback as (err: Error | undefined, client?: pg.PoolClient, done?: unknown) => void;
      return originalConnect((err: Error | undefined, client?: pg.PoolClient, done?: unknown) => {
        if (!err && client) instrumentClient(health, client);
        cb(err, client, done);
      });
    }

    const result = originalConnect(...args);
    if (result instanceof Promise) {
      return result.then((client: pg.PoolClient) => {
        instrumentClient(health, client);
        return client;
      });
    }
    return result;
  };

  return health;
}

/** Marker on a client whose `release` is already wrapped for this checkout. */
const CHECKOUT_ID = Symbol('n409.poolHealth.checkoutId');

/**
 * Record this checkout and arrange for `release` to clear it.
 *
 * `release` is re-wrapped on every checkout rather than once per physical
 * client, because pg replaces it on each acquisition — the function that
 * returns client #3 to the pool is a different closure each time it is lent
 * out. Wrapping once would leave every checkout after the first untracked.
 */
function instrumentClient(health: PoolHealth, client: pg.PoolClient): void {
  const id = health.acquired();
  const marked = client as pg.PoolClient & { [CHECKOUT_ID]?: number | null };
  marked[CHECKOUT_ID] = id;

  const originalRelease = client.release.bind(client) as (...args: unknown[]) => unknown;
  (client as { release: unknown }).release = function release(...args: unknown[]) {
    // Deregister first. If the underlying release throws — it does, on a client
    // released twice — the checkout is still accounted for, where doing it
    // afterwards would leave a phantom that reads as a leak forever.
    health.released(marked[CHECKOUT_ID] ?? null);
    marked[CHECKOUT_ID] = null;
    return originalRelease(...args);
  };
}

/**
 * Log a sample's findings.
 *
 * Split out from `sample()` so the detection is testable without a logger, in
 * the same spirit as `evaluateJobAlerts` — the rules take inputs and return
 * findings, and everything about who gets told lives at the edge.
 */
export function reportPoolFindings(findings: PoolFindings, log: PoolHealthLogger): void {
  for (const leak of findings.leaks) {
    log.error(
      {
        alert: true,
        checkoutId: leak.id,
        heldMs: leak.heldMs,
        // The acquisition stack, which is the whole point of the report.
        acquiredAt: leak.stack,
        pool: findings.snapshot,
      },
      'database connection held far longer than any statement should take — suspected leak',
    );
  }
  if (findings.exhausted) {
    log.error(
      { alert: true, pool: findings.snapshot },
      'database connection pool exhausted — every client is checked out and callers are queued',
    );
  }
}
