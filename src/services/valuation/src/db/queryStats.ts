/**
 * Which query is slow, and how slow, and how often.
 *
 * The pool has had a `statement_timeout` since B-3 §DB pool, so a runaway query
 * is killed rather than pinning a connection forever. That is a backstop, not
 * an answer: it fires at 15 seconds, and everything that makes this service
 * feel slow lives well below it. A dashboard endpoint that has quietly grown to
 * 800ms because a filter stopped hitting an index never trips a timeout, never
 * appears in the HTTP error rate, and shows up only as users saying the app got
 * slower. The RED metrics say *which route* is slow; nothing said which
 * statement inside it.
 *
 * So: time every statement, group them by fingerprint, and keep a bounded table
 * of the worst. Two outputs, deliberately different in kind —
 *
 *  - a `warn` log line per statement over the threshold, which is what you want
 *    when chasing one slow request through a request id, and
 *  - an aggregate ranked by *total* time, which is what you want when deciding
 *    what to fix: the 40ms query run 900 times a minute costs more than the
 *    900ms one run twice, and only the aggregate shows it.
 *
 * Instrumentation is per physical connection (see `instrumentPool`), so it
 * covers `pool.query` and everything inside a `withTransaction` alike, without
 * either caller knowing.
 */

import type pg from 'pg';

// ── Fingerprinting ────────────────────────────────────────────────────────────

/** Longest fingerprint kept; longer statements are truncated with an ellipsis. */
const MAX_FINGERPRINT = 300;

/**
 * Collapses a statement to the shape it shares with every other execution of
 * the same query: parameters, literals and whitespace go, structure stays.
 *
 * Without this the aggregate is useless — a repo that inlines an id list gets
 * one bucket per distinct list, and the table fills with a thousand singletons
 * instead of naming the one query that is actually expensive.
 *
 * Literals are replaced rather than kept because they are also the most likely
 * place for client data to appear: a fingerprint is logged, and a WHERE clause
 * on an email address should not be. Every branch below either drops a value or
 * keeps a keyword, so a fingerprint carries no row content by construction.
 */
export function fingerprintSql(sql: string): string {
  let out = sql;

  // Comments first: a `--` comment can contain quotes that would otherwise
  // unbalance the string-literal pass.
  out = out.replace(/--[^\n]*/g, ' ');
  out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');

  // String literals, including the doubled-quote escape ('it''s' is one
  // literal, not two). Dollar-quoted bodies ($$…$$) go the same way.
  out = out.replace(/\$\$[\s\S]*?\$\$/g, '?');
  out = out.replace(/'(?:[^']|'')*'/g, '?');

  // Placeholders. Done before numbers so `$12` collapses whole rather than
  // leaving a stray `$`.
  out = out.replace(/\$\d+/g, '?');

  // Numeric literals, but only standalone ones — the `8` in `int8` or in a
  // column called `q4_revenue` is part of a name, not a value.
  out = out.replace(/\b\d+(?:\.\d+)?\b/g, '?');

  // A varying-length parameter list is one shape: `IN (?, ?, ?)` → `IN (?)`.
  out = out.replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, '(?)');

  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_FINGERPRINT ? out.slice(0, MAX_FINGERPRINT) + '…' : out;
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

export interface QueryStat {
  fingerprint: string;
  count: number;
  totalMs: number;
  maxMs: number;
  /** Statements over the slow threshold, a subset of `count`. */
  slowCount: number;
  meanMs: number;
}

/**
 * A bounded per-fingerprint table.
 *
 * Bounded because this is a long-lived process and the key space is only
 * *mostly* small: one repo inlining an unparameterised value would otherwise
 * grow the map without limit, turning a diagnostic into the leak it was meant
 * to find. When full, the cheapest entry by total time is evicted — the
 * opposite of what you want to keep, which is exactly why it is the one to
 * drop.
 */
export class QueryStats {
  private readonly stats = new Map<string, QueryStat>();

  constructor(private readonly maxFingerprints = 500) {}

  record(fingerprint: string, durationMs: number, slow: boolean): void {
    let stat = this.stats.get(fingerprint);
    if (!stat) {
      if (this.stats.size >= this.maxFingerprints) this.evictCheapest();
      stat = { fingerprint, count: 0, totalMs: 0, maxMs: 0, slowCount: 0, meanMs: 0 };
      this.stats.set(fingerprint, stat);
    }
    stat.count += 1;
    stat.totalMs += durationMs;
    stat.maxMs = Math.max(stat.maxMs, durationMs);
    if (slow) stat.slowCount += 1;
    stat.meanMs = stat.totalMs / stat.count;
  }

  private evictCheapest(): void {
    let victim: string | undefined;
    let lowest = Infinity;
    for (const [key, stat] of this.stats) {
      if (stat.totalMs < lowest) {
        lowest = stat.totalMs;
        victim = key;
      }
    }
    if (victim !== undefined) this.stats.delete(victim);
  }

  /**
   * The worst `limit` fingerprints by total time spent.
   *
   * Ranked on total rather than mean or max because that is the number that
   * answers "what should I fix first" — see the header note on the 40ms query
   * run 900 times. `maxMs` and `meanMs` come along so the caller can tell a
   * uniformly-slow query from one with a bad tail.
   */
  top(limit = 20): QueryStat[] {
    return [...this.stats.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }

  reset(): void {
    this.stats.clear();
  }

  get size(): number {
    return this.stats.size;
  }
}

// ── Pool instrumentation ──────────────────────────────────────────────────────

export interface InstrumentOptions {
  /** Statements at or over this many ms are logged individually. */
  slowMs: number;
  /** Where the slow-query lines go. */
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
  /** Collected aggregate; defaults to a fresh table. */
  stats?: QueryStats;
  /** Injectable clock, so tests need no real elapsed time. */
  now?: () => number;
}

/** Marker so a client is never wrapped twice, whatever else touches the pool. */
const WRAPPED = Symbol('n409.queryStats.wrapped');

/** The SQL text out of pg's several `query` call shapes. */
function sqlTextOf(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first !== null && typeof first === 'object' && 'text' in first) {
    const text = (first as { text: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

/**
 * Times every statement run on `pool` and returns the aggregate.
 *
 * Hooked on the pool's `connect` event rather than by replacing `pool.query`:
 * `pool.query` itself checks out a client and calls `client.query`, so wrapping
 * the client catches both it and the explicit `pool.connect()` that
 * `withTransaction` uses — where the interesting statements live. The event
 * fires once per *physical* connection, not per checkout, so each client is
 * wrapped exactly once and a pool of ten costs ten wraps for the process.
 */
export function instrumentPool(pool: pg.Pool, opts: InstrumentOptions): QueryStats {
  const stats = opts.stats ?? new QueryStats();
  const now = opts.now ?? (() => performance.now());

  pool.on('connect', (client: pg.PoolClient) => {
    const marked = client as pg.PoolClient & { [WRAPPED]?: boolean };
    if (marked[WRAPPED]) return;
    marked[WRAPPED] = true;

    const original = client.query.bind(client) as (...args: unknown[]) => unknown;

    (client as { query: unknown }).query = function query(...args: unknown[]) {
      const text = sqlTextOf(args);
      // The callback form does not return a promise to hang timing off. It is
      // unused in this service, so pass it through rather than grow a second
      // timing path that nothing exercises.
      if (text === null || typeof args[args.length - 1] === 'function') {
        return original(...args);
      }

      const started = now();
      const finish = () => {
        const durationMs = now() - started;
        const fingerprint = fingerprintSql(text);
        const slow = durationMs >= opts.slowMs;
        stats.record(fingerprint, durationMs, slow);
        if (slow) {
          // Rounded: sub-millisecond precision on a figure this size is noise,
          // and it keeps the log line stable enough to group on.
          opts.log.warn(
            { sql: fingerprint, durationMs: Math.round(durationMs), slowMs: opts.slowMs },
            'slow query',
          );
        }
      };

      let result: unknown;
      try {
        result = original(...args);
      } catch (err) {
        // A synchronous throw is a client-state error, not a slow query, but it
        // still consumed time somebody may be looking for.
        finish();
        throw err;
      }
      // Record on settle either way: a statement that failed after 4 seconds is
      // exactly the one worth seeing, and dropping it hides timeouts.
      if (result instanceof Promise) return result.finally(finish);
      finish();
      return result;
    };
  });

  return stats;
}
