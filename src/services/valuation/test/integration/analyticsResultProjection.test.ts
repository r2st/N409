import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createValuation } from '../../src/repos/valuations.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { buildAnalytics } from '../../src/domain/valuationAnalytics.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/**
 * The analytics series must read the part of `results` it uses, not the document.
 *
 * `GET /valuations/:id/analytics` selects the newest succeeded calculation of
 * every same-company 409A and hands `results` to `buildAnalytics`, which reads
 * five scalars and the comparable-multiple list. It used to select the column:
 * the allocation, its breakpoints and the whole per-class waterfall crossed the
 * wire and went through the driver's `JSON.parse` once per prior valuation of
 * the company, with no ceiling on how many that is. A 409A `results` is 11 kB at
 * ten share classes and 613 kB at the 200 cap (R322 measured them).
 *
 * R283's asymmetry question is what found it: `historyFor` in routes/reports.ts
 * asks the same question of the same table through the same `sameCompanyFilter`
 * and its LATERAL selects three columns, because three is what it reads.
 *
 * WHAT IS ASSERTED, and why it is not a stopwatch. The answer is identical
 * either way — that is the whole point of `analyticsResultsSql` being a
 * `jsonb_build_object` rather than a rewrite of `buildAnalytics` — so a guard
 * over the response cannot see this, the same way R322's
 * `not.toHaveProperty('results')` could not see an over-fetch that happened
 * before the response was built. So: the **bytes the statement returns**,
 * stated as a difference. Deepen every stored allocation tenfold and the bytes
 * read must not move. Plus the answer, against `buildAnalytics` run over the
 * full documents, so a narrowing that drops something the reader needs fails
 * here rather than in a chart nobody diffed.
 *
 * Run against the pre-fix route both assertions fail: the rows carry
 * `allocation`, and their size grows with it.
 */
const VALUATIONS = 6;

/** A stored engine result with a realistic allocation blob under the keys read. */
function resultsDoc(fmv: number, breakpoints: number): Record<string, unknown> {
  return {
    fmv_per_share: fmv,
    equity_value: fmv * 1_000_000,
    discounts: { dlom: 0.23, dloc: 0.05, method: 'finnerty' },
    assumptions: { volatility: 0.71, risk_free_rate: 0.042 },
    approaches: {
      market: { selected_multiple: 6.2, multiples: [4, 5, 6, 7, 28], weight: 0.4 },
      income: { value: 1e8, weight: 0.4, dcf: { periods: 10 } },
    },
    // The half nothing above reads, and the half that is the document's size.
    allocation: {
      method: 'opm',
      breakpoints: Array.from({ length: breakpoints }, (_, i) => ({
        index: i,
        from: i * 1e6,
        to: (i + 1) * 1e6,
        participants: Array.from({ length: 12 }, (_, k) => ({
          class: `Series ${k}`,
          shares: 1000 * k + i,
          pct: (k + 1) / 12,
          proceeds: i * 1234.56,
        })),
      })),
    },
  };
}

/** Records the SQL and the rows of every statement the request issues. */
function tap(pool: pg.Pool): { seen: Array<{ sql: string; rows: unknown[] }>; restore: () => void } {
  const seen: Array<{ sql: string; rows: unknown[] }> = [];
  const original = pool.query.bind(pool);
  (pool as unknown as { query: (...a: unknown[]) => unknown }).query = async (...args: unknown[]) => {
    const first = args[0];
    const sql = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    const result = (await (original as (...a: unknown[]) => unknown)(...args)) as { rows?: unknown[] };
    seen.push({ sql, rows: result?.rows ?? [] });
    return result;
  };
  return { seen, restore: () => ((pool as unknown as { query: unknown }).query = original) };
}

describe.skipIf(!dbUp)('analytics reads the part of results it uses (R393, M8)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function seedCompany(company: string, breakpoints: number): Promise<string> {
    let last = '';
    for (let i = 0; i < VALUATIONS; i++) {
      const v = await createValuation(
        ctx.pool,
        { kind: '409a', companyName: company, userId: ops.id, partnerId: null },
        { ...actor, actorId: ops.id },
      );
      const doc = resultsDoc(2 + i, breakpoints);
      await createCalculation(
        ctx.pool,
        {
          valuationId: v.id,
          engineVersion: 'test',
          status: 'succeeded',
          inputs: { valuation_date: `2025-0${i + 1}-01` },
          results: doc,
          equityValue: (2 + i) * 1_000_000,
          fmvPerShare: 2 + i,
          createdBy: ops.id,
        },
        { ...actor, actorId: ops.id },
      );
      last = v.id;
    }
    return last;
  }

  /** Bytes of `results` the analytics statement handed back, and the answer with it. */
  async function measure(valuationId: string): Promise<{ bytes: number; body: unknown }> {
    const t = tap(ctx.pool);
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/analytics`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const series = t.seen.filter((s) => /FROM calculations/i.test(s.sql) && s.rows.length === VALUATIONS);
      expect(series).toHaveLength(1);
      const bytes = Buffer.byteLength(
        JSON.stringify(series[0]!.rows.map((r) => (r as { results: unknown }).results)),
      );
      return { bytes, body: res.json().analytics };
    } finally {
      t.restore();
    }
  }

  it('does not grow with the part of the document nothing reads', async () => {
    const shallow = await measure(await seedCompany('ProjectionCo Shallow', 5));
    const deep = await measure(await seedCompany('ProjectionCo Deep', 50));

    // The stored documents differ by an order of magnitude; what the statement
    // returns must not move at all.
    expect(Buffer.byteLength(JSON.stringify(resultsDoc(2, 50)))).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(resultsDoc(2, 5))) * 5,
    );
    expect(deep.bytes).toBe(shallow.bytes);
    expect(deep.bytes).toBeLessThan(2_000);
  });

  it('answers exactly what the whole document answers', async () => {
    const id = await seedCompany('ProjectionCo Identity', 20);
    const { body } = await measure(id);

    // The same rows, read wide, through the same reader.
    const { rows } = await ctx.pool.query<{
      calculation_id: string;
      valuation_id: string;
      as_of: string;
      results: Record<string, unknown>;
    }>(
      `SELECT c.id AS calculation_id, c.valuation_id,
              COALESCE(
                NULLIF(substring(c.inputs->>'valuation_date' from '^\\d{4}-\\d{2}-\\d{2}'), ''),
                to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
              ) AS as_of,
              c.results
         FROM valuations v
         JOIN LATERAL (
           SELECT id, valuation_id, created_at, inputs, results
             FROM calculations
            WHERE valuation_id = v.id AND status = 'succeeded' AND results IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1
         ) c ON true
        WHERE v.user_id = $1 AND v.company_name = $2 AND v.archived_at IS NULL
        ORDER BY as_of ASC, c.created_at ASC`,
      [ops.id, 'ProjectionCo Identity'],
    );
    expect(rows).toHaveLength(VALUATIONS);
    // The route attaches `valuation_number` to each point; compare the analytics
    // the two documents produce, which is what the narrowing has to preserve.
    const wide = buildAnalytics(rows);
    const narrow = body as { series: Array<Record<string, unknown>>; count: number };
    expect(narrow.count).toBe(wide.count);
    expect((body as { trends: unknown }).trends).toEqual(wide.trends);
    expect((body as { benchmark: unknown }).benchmark).toEqual(wide.benchmark);
    expect(narrow.series.map(({ valuation_number: _n, ...p }) => p)).toEqual(
      wide.series.map((p) => ({ ...p })),
    );
  });
});
