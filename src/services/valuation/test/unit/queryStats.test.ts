import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { fingerprintSql, instrumentPool, QueryStats } from '../../src/db/queryStats.js';

describe('fingerprintSql', () => {
  it('collapses placeholders so every execution shares one bucket', () => {
    expect(fingerprintSql('SELECT * FROM valuations WHERE id = $1 AND state = $2')).toBe(
      'SELECT * FROM valuations WHERE id = ? AND state = ?',
    );
  });

  it('collapses a varying-length IN list to one shape', () => {
    const three = fingerprintSql('SELECT * FROM documents WHERE id IN ($1, $2, $3)');
    const one = fingerprintSql('SELECT * FROM documents WHERE id IN ($1)');
    expect(three).toBe(one);
    expect(three).toBe('SELECT * FROM documents WHERE id IN (?)');
  });

  it('normalises whitespace so a reformatted query is the same query', () => {
    expect(fingerprintSql('SELECT   a,\n  b\n FROM t')).toBe('SELECT a, b FROM t');
  });

  /**
   * The privacy half of the contract: a fingerprint is logged, so an inlined
   * literal must not survive into it. A WHERE on an email address is the case
   * that matters.
   */
  it('drops string literals rather than logging client data', () => {
    const fp = fingerprintSql("SELECT * FROM users WHERE email = 'someone@example.com'");
    expect(fp).toBe('SELECT * FROM users WHERE email = ?');
    expect(fp).not.toContain('example.com');
  });

  it('handles the doubled-quote escape as one literal', () => {
    expect(fingerprintSql("SELECT * FROM c WHERE name = 'it''s here' AND x = 1")).toBe(
      'SELECT * FROM c WHERE name = ? AND x = ?',
    );
  });

  it('drops dollar-quoted bodies', () => {
    expect(fingerprintSql('SELECT $$secret payload$$ AS x')).toBe('SELECT ? AS x');
  });

  it('strips comments, including quotes inside them', () => {
    expect(fingerprintSql("SELECT a -- don't count this\nFROM t")).toBe('SELECT a FROM t');
    expect(fingerprintSql('SELECT /* note */ a FROM t')).toBe('SELECT a FROM t');
  });

  /** A digit inside an identifier is part of the name, not a value. */
  it('leaves digits that belong to identifiers alone', () => {
    expect(fingerprintSql('SELECT q4_revenue FROM asc718_settings')).toBe(
      'SELECT q4_revenue FROM asc718_settings',
    );
  });

  it('truncates a statement too long to be a useful key', () => {
    const fp = fingerprintSql('SELECT ' + 'a'.repeat(1000) + ' FROM t');
    expect(fp.length).toBeLessThanOrEqual(301);
    expect(fp.endsWith('…')).toBe(true);
  });
});

describe('QueryStats', () => {
  it('accumulates count, total, max and the slow subset per fingerprint', () => {
    const stats = new QueryStats();
    stats.record('SELECT ?', 10, false);
    stats.record('SELECT ?', 30, true);
    const [stat] = stats.top();
    expect(stat).toMatchObject({ count: 2, totalMs: 40, maxMs: 30, slowCount: 1, meanMs: 20 });
  });

  /**
   * The ranking choice the module exists to make: the cheap query run often
   * costs more than the expensive one run twice, and only a total-time ranking
   * puts it first.
   */
  it('ranks by total time, not by the slowest single run', () => {
    const stats = new QueryStats();
    // 30 × 40ms = 1200ms of database time, against one 900ms outlier.
    for (let i = 0; i < 30; i++) stats.record('frequent', 40, false);
    stats.record('rare', 900, true);

    const ranked = stats.top();
    expect(ranked[0]!.fingerprint).toBe('frequent');
    // …even though the outlier is by far the slowest single run.
    expect(ranked[1]!.maxMs).toBeGreaterThan(ranked[0]!.maxMs);
  });

  it('honours the limit', () => {
    const stats = new QueryStats();
    for (let i = 0; i < 10; i++) stats.record(`q${i}`, i, false);
    expect(stats.top(3)).toHaveLength(3);
  });

  /**
   * Bounded on purpose: an unparameterised query would otherwise grow the map
   * without limit in a long-lived process, turning the diagnostic into the leak
   * it was added to find.
   */
  it('evicts the cheapest fingerprint rather than growing without bound', () => {
    const stats = new QueryStats(3);
    stats.record('expensive', 500, true);
    stats.record('cheap', 1, false);
    stats.record('middling', 50, false);
    stats.record('new', 10, false); // forces an eviction

    expect(stats.size).toBe(3);
    const kept = stats.top().map((s) => s.fingerprint);
    expect(kept).toContain('expensive');
    expect(kept).not.toContain('cheap');
  });
});

// ── instrumentPool ────────────────────────────────────────────────────────────

/** A pool whose `connect` event can be fired with a client we control. */
function fakePool() {
  const emitter = new EventEmitter();
  const pool = emitter as unknown as pg.Pool;
  const inner = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const client = { query: inner } as unknown as pg.PoolClient;
  return { pool, client, inner, connect: () => emitter.emit('connect', client) };
}

function fakeLog() {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return { lines, warn: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }) };
}

/** A clock that advances by `step` on every read after the first. */
function steppedClock(step: number) {
  let t = 0;
  return () => {
    const value = t;
    t += step;
    return value;
  };
}

describe('instrumentPool', () => {
  it('times statements run on a pooled client', async () => {
    const { pool, client, connect } = fakePool();
    const log = fakeLog();
    const stats = instrumentPool(pool, { slowMs: 10, log, now: steppedClock(5) });
    connect();

    await client.query('SELECT * FROM valuations WHERE id = $1', ['x']);
    expect(stats.top()[0]).toMatchObject({
      fingerprint: 'SELECT * FROM valuations WHERE id = ?',
      count: 1,
      totalMs: 5,
    });
  });

  it('logs a statement at or over the threshold, and only then', async () => {
    const { pool, client, connect } = fakePool();
    const log = fakeLog();
    instrumentPool(pool, { slowMs: 50, log, now: steppedClock(5) });
    connect();
    await client.query('SELECT 1');
    expect(log.lines).toHaveLength(0);

    const slow = fakePool();
    const slowLog = fakeLog();
    instrumentPool(slow.pool, { slowMs: 50, log: slowLog, now: steppedClock(500) });
    slow.connect();
    await slow.client.query('SELECT * FROM valuations WHERE id = $1');
    expect(slowLog.lines).toHaveLength(1);
    expect(slowLog.lines[0]!.msg).toBe('slow query');
    expect(slowLog.lines[0]!.obj).toMatchObject({
      sql: 'SELECT * FROM valuations WHERE id = ?',
      durationMs: 500,
    });
  });

  /**
   * A statement that failed after four seconds is exactly the one worth seeing;
   * recording only successes would hide every timeout.
   */
  it('records a failed statement and lets the error through', async () => {
    const emitter = new EventEmitter();
    const pool = emitter as unknown as pg.Pool;
    const boom = new Error('deadlock detected');
    const client = {
      query: vi.fn(async () => {
        throw boom;
      }),
    } as unknown as pg.PoolClient;
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(80) });
    emitter.emit('connect', client);

    await expect(client.query('UPDATE valuations SET state = $1')).rejects.toBe(boom);
    expect(stats.top()[0]).toMatchObject({ count: 1, totalMs: 80, slowCount: 1 });
  });

  /** Each physical connection is wrapped once, however often it is checked out. */
  it('does not double-wrap a client', async () => {
    const { pool, client, inner, connect } = fakePool();
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(5) });
    connect();
    connect();

    await client.query('SELECT 1');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(stats.top()[0]!.count).toBe(1);
  });

  /**
   * The callback form is not an exotic path: `pool.query` dispatches through it
   * (`client.query(text, values, cb)` in pg-pool), so skipping it once meant
   * every statement outside a transaction went untimed. See the real-pool test
   * at the bottom of this file, which is the one that would have caught it.
   */
  it('times the callback form and calls back once', () => {
    const emitter = new EventEmitter();
    const pool = emitter as unknown as pg.Pool;
    const result = { rows: [{ n: 1 }], rowCount: 1 };
    const inner = vi.fn((_sql: string, _values: unknown, cb: (e: unknown, r: unknown) => void) => {
      cb(null, result);
    });
    const client = { query: inner } as unknown as pg.PoolClient;
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(7) });
    emitter.emit('connect', client);

    const seen: unknown[] = [];
    (client.query as unknown as (sql: string, values: unknown, cb: (e: unknown, r: unknown) => void) => void)(
      'SELECT * FROM valuations WHERE id = $1',
      ['x'],
      (err, res) => seen.push([err, res]),
    );

    expect(seen).toEqual([[null, result]]);
    expect(stats.top()[0]).toMatchObject({
      fingerprint: 'SELECT * FROM valuations WHERE id = ?',
      count: 1,
      totalMs: 7,
    });
  });

  /** A failed callback-form statement is still time somebody spent waiting. */
  it('records a callback-form failure without swallowing the error', () => {
    const emitter = new EventEmitter();
    const pool = emitter as unknown as pg.Pool;
    const boom = new Error('syntax error at or near "SELCT"');
    const client = {
      query: vi.fn((_sql: string, cb: (e: unknown) => void) => cb(boom)),
    } as unknown as pg.PoolClient;
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(60) });
    emitter.emit('connect', client);

    let caught: unknown;
    (client.query as unknown as (sql: string, cb: (e: unknown) => void) => void)('SELCT 1', (err) => {
      caught = err;
    });
    expect(caught).toBe(boom);
    expect(stats.top()[0]).toMatchObject({ count: 1, totalMs: 60, slowCount: 1 });
  });

  /**
   * A `Submittable` (cursor, streaming query) returns the object itself and
   * finishes long after the call, so there is no honest duration to record.
   * Better no row than a row claiming every cursor takes 0ms.
   */
  it('leaves a submittable alone rather than recording a fictional 0ms', () => {
    const emitter = new EventEmitter();
    const pool = emitter as unknown as pg.Pool;
    const submittable = { text: 'SELECT * FROM valuations', submit: () => {} };
    const client = { query: vi.fn((q: unknown) => q) } as unknown as pg.PoolClient;
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(5) });
    emitter.emit('connect', client);

    const returned = (client.query as unknown as (q: unknown) => unknown)(submittable);
    expect(returned).toBe(submittable);
    expect(stats.size).toBe(0);
  });

  it('ignores a query it cannot read the SQL out of', async () => {
    const { pool, client, inner, connect } = fakePool();
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(5) });
    connect();

    await (client.query as unknown as (c: { text: number }) => Promise<unknown>)({ text: 42 });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(stats.size).toBe(0);
  });

  /** A synchronous throw still consumed time somebody may be looking for. */
  it('records a synchronous throw and rethrows it', () => {
    const emitter = new EventEmitter();
    const pool = emitter as unknown as pg.Pool;
    const boom = new Error('client has been closed');
    const client = {
      query: vi.fn(() => {
        throw boom;
      }),
    } as unknown as pg.PoolClient;
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(3) });
    emitter.emit('connect', client);

    expect(() => client.query('SELECT 1')).toThrow(boom);
    expect(stats.top()[0]).toMatchObject({ count: 1, totalMs: 3 });
  });

  it('records a non-promise return once, not twice', () => {
    const emitter = new EventEmitter();
    const pool = emitter as unknown as pg.Pool;
    const client = {
      query: vi.fn(() => ({ rows: [], rowCount: 0 })),
    } as unknown as pg.PoolClient;
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(4) });
    emitter.emit('connect', client);

    client.query('SELECT 1');
    expect(stats.top()[0]).toMatchObject({ count: 1, totalMs: 4 });
  });

  it('reads the config-object call shape as well as the string one', async () => {
    const { pool, client, connect } = fakePool();
    const stats = instrumentPool(pool, { slowMs: 10, log: fakeLog(), now: steppedClock(5) });
    connect();

    await (client.query as unknown as (c: { text: string; values: unknown[] }) => Promise<unknown>)({
      text: 'SELECT * FROM documents WHERE valuation_id = $1',
      values: ['x'],
    });
    expect(stats.top()[0]!.fingerprint).toBe('SELECT * FROM documents WHERE valuation_id = ?');
  });
});

// ── instrumentPool over a real pg.Pool ────────────────────────────────────────

/**
 * The tests above hand-fire the `connect` event and call the wrapped client
 * directly, which is why they all passed while the instrumentation recorded
 * nothing in production: they never went through `pg.Pool` itself.
 *
 * `pg.Pool` takes a `Client` constructor, so the dispatch path — `pool.query`
 * → `pool.connect` → `emit('connect')` → `client.query(text, values, cb)` —
 * can be exercised for real with no database behind it. That path is the one
 * 81 of this service's call sites take.
 */
class StubClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  release?: (err?: unknown) => void;
  readonly seen: string[] = [];

  connect(cb: (err?: Error) => void): void {
    setImmediate(() => cb());
  }

  /** Both shapes pg exposes, since the pool uses one and callers use the other. */
  query(text: string, ...rest: unknown[]): Promise<unknown> | void {
    this.seen.push(text);
    const result = { rows: [], rowCount: 0, command: 'SELECT' };
    const cb = rest[rest.length - 1];
    if (typeof cb === 'function') {
      setImmediate(() => (cb as (e: unknown, r: unknown) => void)(null, result));
      return;
    }
    return new Promise((resolve) => setImmediate(() => resolve(result)));
  }

  end(cb?: () => void): void {
    this._ending = true;
    if (cb) setImmediate(cb);
  }
}

describe('instrumentPool over a real pg.Pool', () => {
  /** A clock that advances a fixed step per read, so durations are exact. */
  function pool(step: number) {
    const p = new pg.Pool({ Client: StubClient as unknown as typeof pg.Client, max: 2 });
    const log = fakeLog();
    const stats = instrumentPool(p, { slowMs: 25, log, now: steppedClock(step) });
    return { p, log, stats };
  }

  /**
   * The regression this file exists for. `pool.query` is the majority call
   * shape in this service, and it dispatches through the callback form; before
   * the fix this recorded nothing and the ops endpoint reported an empty table
   * on a busy process.
   */
  it('records a statement issued through pool.query', async () => {
    const { p, stats } = pool(5);
    await p.query('SELECT * FROM valuations WHERE id = $1', ['x']);

    expect(stats.size).toBe(1);
    expect(stats.top()[0]).toMatchObject({
      fingerprint: 'SELECT * FROM valuations WHERE id = ?',
      count: 1,
      totalMs: 5,
    });
    await p.end();
  });

  it('logs a slow pool.query at the threshold', async () => {
    const { p, log, stats } = pool(300);
    await p.query('SELECT * FROM documents WHERE valuation_id = $1', ['v']);

    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]!.obj).toMatchObject({
      sql: 'SELECT * FROM documents WHERE valuation_id = ?',
      durationMs: 300,
      slowMs: 25,
    });
    expect(stats.top()[0]!.slowCount).toBe(1);
    await p.end();
  });

  /** Both halves of the promise the module header makes: pool *and* transaction. */
  it('records statements inside a checked-out client, sharing one table', async () => {
    const { p, stats } = pool(5);
    await p.query('SELECT ? FROM boot');

    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE valuations SET state = $1 WHERE id = $2', ['final', 'x']);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const kept = stats.top().map((s) => s.fingerprint);
    expect(kept).toContain('SELECT ? FROM boot');
    expect(kept).toContain('BEGIN');
    expect(kept).toContain('UPDATE valuations SET state = ? WHERE id = ?');
    await p.end();
  });

  /** One physical connection reused across checkouts is still wrapped once. */
  it('counts a reused connection once per statement, not once per checkout', async () => {
    const { p, stats } = pool(5);
    await p.query('SELECT 1');
    await p.query('SELECT 1');
    await p.query('SELECT 1');

    expect(stats.size).toBe(1);
    expect(stats.top()[0]).toMatchObject({ fingerprint: 'SELECT ?', count: 3 });
    await p.end();
  });
});
