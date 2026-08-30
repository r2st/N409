import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { SCALING_ENDPOINTS as ENDPOINTS } from '../support/listEndpoints.js';

const dbUp = await isDbAvailable();

/**
 * Every collection endpoint costs the same number of statements whatever the
 * collection holds.
 *
 * `batchedReads.test.ts` pins the three request paths whose N+1 was found and
 * batched, by name and by statement shape. That is the regression guard for
 * three known bugs; it says nothing about the fortieth list endpoint somebody
 * adds next month. This is the population guard beside it — the same argument
 * R91 made for the sweep census: a check phrased "these known cases are fine"
 * only catches regressions in those cases, and one phrased "account for every
 * one" catches the additions its author never imagined.
 *
 * The measurement is a ratio, not a count. Each endpoint is called once with a
 * few rows behind it and once with four times as many, and the second call may
 * not issue *more* statements than the first. Deliberately not "issues exactly
 * two": endpoints legitimately differ — one does a count and a page, another
 * folds both into a window function, a third reads a settings row first — and
 * pinning absolute numbers here would turn every honest refactor into a failing
 * test while still missing the loop that runs once per row.
 *
 * The inequality is `<=` rather than `===` because a cached read is a *fall*:
 * `/api/v1/valuations/counts` and `/api/v1/stats/dashboard` both warm a TTL
 * cache on the first call, and the second call is cheaper. A drop is never the
 * bug this is looking for.
 *
 * `pool.query` is the seam, as in `batchedReads.test.ts`: reads go through the
 * pool, and writes on a checked-out transaction client are invisible to it —
 * which is the right cut for GET routes.
 *
 * The roster lives in `support/listEndpoints.ts` rather than here, because a
 * hand-kept list inside a suite that skips itself without a database has no
 * guard on the machines where it is skipped — and it had drifted thirteen
 * endpoints behind. `listScalingCoverage.test.ts` is the guard, and it needs
 * no database.
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

/** Rows behind the first measurement, and the multiple behind the second. */
const SEED_ROWS = 4;
const GROWTH = 4;

describe.skipIf(!dbUp)('collection endpoints do not scale their statement count with the collection', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };
  let partnerId: string;
  let firmUser: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    partnerId = await seedPartner(ctx, 'Scaling Firm');
    firmUser = await seedUser(ctx, { roles: ['partner'], partnerId });
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  async function seedValuations(n: number, tag: string): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      // Half under the firm so the partner-scoped console grows too.
      const as = i % 2 === 0 ? firmUser : ops;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(as.token),
        payload: { kind: '409a', company_name: `Scaling ${tag} ${i}` },
      });
      if (res.statusCode >= 400) throw new Error(`seed failed (${res.statusCode}): ${res.body}`);
    }
  }

  async function measure(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const [label, template] of ENDPOINTS) {
      const url = template.replace(':partner', partnerId);
      const tap = tapQueries(ctx.pool);
      let res;
      try {
        res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(ops.token) });
      } finally {
        tap.restore();
      }
      // A 4xx would make the count meaningless — an endpoint that refuses the
      // call issues no statements and would "pass" forever. Fail loudly instead.
      if (res.statusCode >= 400)
        throw new Error(`${label} answered ${res.statusCode}: ${res.body.slice(0, 200)}`);
      counts.set(label, tap.statements.length);
    }
    return counts;
  }

  it('issues no more statements for four times the rows', async () => {
    await seedValuations(SEED_ROWS, 'base');
    const small = await measure();
    await seedValuations(SEED_ROWS * (GROWTH - 1), 'grown');
    const large = await measure();

    const grew = ENDPOINTS.map(([label]) => ({
      label,
      small: small.get(label)!,
      large: large.get(label)!,
    })).filter((row) => row.large > row.small);

    expect(
      grew.map(
        (r) => `${r.label}: ${r.small} statements at ${SEED_ROWS} rows, ${r.large} at ${SEED_ROWS * GROWTH}`,
      ),
    ).toEqual([]);

    // And the measurement was real: every endpoint issued at least one
    // statement, so a route that quietly stopped touching the database cannot
    // pass this by doing nothing.
    expect([...small.entries()].filter(([, n]) => n === 0).map(([label]) => label)).toEqual([]);
  }, 180_000);
});
