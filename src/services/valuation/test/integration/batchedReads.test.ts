import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The N+1 reads that were batched out of the request paths, pinned by counting
 * the statements rather than by timing them.
 *
 * A timing assertion on a loop that got faster is a flake waiting for a busy
 * CI box; the count is the thing that actually regressed, and it is exact. So
 * each test here asserts a *shape* — "one read for the selection, none per
 * row" — which fails the moment a single-row read finds its way back into a
 * loop, however fast the suite happens to run that day.
 *
 * `pool.query` is the seam because that is what every repo read calls.
 * Transactional writes go through a checked-out client instead, so they are
 * invisible here — which is the right cut: this is about reads that scale with
 * the size of the batch, not about the writes that are inherently per-row.
 */
interface QueryTap {
  statements: string[];
  restore: () => void;
}

function tapQueries(pool: pg.Pool): QueryTap {
  const statements: string[] = [];
  const original = pool.query.bind(pool);
  const patched = (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    statements.push(text.replace(/\s+/g, ' ').trim());
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  (pool as unknown as { query: unknown }).query = patched;
  return {
    statements,
    restore: () => {
      (pool as unknown as { query: unknown }).query = original;
    },
  };
}

/** Statements matching `re`, so a count reads as "how many times did this run". */
const matching = (tap: QueryTap, re: RegExp): string[] => tap.statements.filter((s) => re.test(s));

/** The single-row valuation read — the one that used to run once per id. */
const PER_ROW_READ = /SELECT \* FROM valuations WHERE id = \$1/i;
/** Its batch replacement. */
const BATCH_READ = /SELECT \* FROM valuations WHERE id = ANY\(\$1\)/i;

describe.skipIf(!dbUp)('batched reads on bulk request paths', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  async function createValuation(name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  it('reads a bulk selection in one query rather than one per id', async () => {
    const ids = await Promise.all(
      ['Batch A', 'Batch B', 'Batch C', 'Batch D'].map((n) => createValuation(n)),
    );

    const tap = tapQueries(ctx.pool);
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations/bulk',
        headers: authHeader(ops.token),
        payload: { ids, action: 'set_state', state: 'started' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().succeeded).toBe(ids.length);
    } finally {
      tap.restore();
    }

    expect(matching(tap, BATCH_READ)).toHaveLength(1);
    // Not "fewer than before": none at all. The authenticate preHandler reads
    // `users`, not `valuations`, so nothing else on this path can produce one.
    expect(matching(tap, PER_ROW_READ)).toHaveLength(0);
  });

  it('does not grow its read count with the size of the selection', async () => {
    const two = await Promise.all(['Grow A', 'Grow B'].map((n) => createValuation(n)));
    const six = await Promise.all(
      ['Grow C', 'Grow D', 'Grow E', 'Grow F', 'Grow G', 'Grow H'].map((n) => createValuation(n)),
    );

    const readsFor = async (ids: string[]): Promise<number> => {
      const tap = tapQueries(ctx.pool);
      try {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations/bulk',
          headers: authHeader(ops.token),
          payload: { ids, action: 'set_state', state: 'started' },
        });
        expect(res.json().succeeded).toBe(ids.length);
      } finally {
        tap.restore();
      }
      return matching(tap, BATCH_READ).length + matching(tap, PER_ROW_READ).length;
    };

    // Three times the rows, the same number of valuation reads. This is the
    // property; the constant `1` above is just what it happens to be today.
    expect(await readsFor(six)).toBe(await readsFor(two));
  });

  it('still reports an unknown id per row without sinking the batch', async () => {
    const good = await createValuation('Batch Partial');
    const missing = newUlid();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations/bulk',
      headers: authHeader(ops.token),
      payload: { ids: [good, missing, 'not-a-ulid'], action: 'set_state', state: 'started' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      succeeded: number;
      failed: number;
      results: Array<{ id: string; ok: boolean; error?: string }>;
    };
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(2);
    // The prefetch map reports a miss the same way `loadValuation` did — the
    // per-row error text is part of the response contract, not an internal.
    for (const id of [missing, 'not-a-ulid']) {
      const row = body.results.find((r) => r.id === id);
      expect(row?.ok).toBe(false);
      expect(row?.error).toMatch(/not found/i);
    }
  });

  it('reads a repeated id once, and acts on it once', async () => {
    const id = await createValuation('Batch Dupe');
    const tap = tapQueries(ctx.pool);
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations/bulk',
        headers: authHeader(ops.token),
        payload: { ids: [id, id, id], action: 'advance' },
      });
      expect(res.statusCode).toBe(200);
      // dedupeIds collapses the list before the prefetch, so one advance —
      // which is what makes prefetching equivalent to reading per iteration.
      expect(res.json().results).toHaveLength(1);
    } finally {
      tap.restore();
    }
    expect(matching(tap, BATCH_READ)).toHaveLength(1);
  });

  it('resolves both email recipients of a transition in one users read', async () => {
    const reviewer = await seedUser(ctx, { roles: ['analyst'] });
    const id = await createValuation('Recipients');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/workflow/reassign`,
      headers: authHeader(ops.token),
      payload: { reviewer_id: reviewer.id },
    });

    const tap = tapQueries(ctx.pool);
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/workflow/advance`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      tap.restore();
    }

    // The old hook issued `SELECT id, email FROM users WHERE id = $1` once per
    // addressed role. Nothing on this path should now.
    expect(matching(tap, /SELECT id, email FROM users WHERE id = \$1/i)).toHaveLength(0);
    expect(
      matching(tap, /FROM users u.*WHERE u\.id = ANY\(\$1::ulid\[\]\)/i).length,
    ).toBeLessThanOrEqual(1);
  });
});

if (!dbUp) {
  console.warn('[batchedReads.test] Postgres not reachable — skipped. Run: npm run dev:db');
}
