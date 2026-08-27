import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Rendering a report costs the same number of statements whatever the
 * engagement behind it holds.
 *
 * `listQueryScaling.test.ts` makes this argument for every collection endpoint,
 * and the report render is not one — it is a single-row route, so it was never
 * in that population, and it is the one route on the platform that reads eleven
 * different tables to answer one request. `summaryFor` runs them as two waves
 * of `Promise.all`, which is the shape that makes an N+1 easy to reintroduce
 * without noticing: a loader added to the list looks identical whether it reads
 * one row or one row per peer.
 *
 * The measurement is the same ratio `listQueryScaling` uses and for the same
 * reasons — endpoints legitimately differ in how many statements they issue,
 * and pinning an absolute number turns every honest refactor into a failure
 * while still missing the loop that runs once per row. What is asserted is that
 * quadrupling everything the report reads does not buy a single extra
 * statement.
 *
 * The four axes below are the ones that actually grow on a long-lived client:
 * prior valuations (the FMV trend), guideline companies, workbook cells and
 * market research. Each is loaded by its own query in `summaryFor`.
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

const RESULTS = {
  equity_value: 42_000_000,
  fmv_per_share: 1.2345,
  allocation_method: 'opm_waterfall',
  assumptions: { volatility: 0.65, risk_free_rate: 0.042, time_to_exit_years: 3.5 },
  approaches: {
    income: { weight: 0.5, equity_value: 40_000_000 },
    market: { weight: 0.5, equity_value: 44_000_000 },
  },
  allocation: {
    method: 'opm_waterfall',
    common_per_share: 1.2345,
    classes: { Common: { kind: 'common', shares: 8_000_000, value: 19_500_000, per_share: 1.2345 } },
  },
  discounts: { dloc: 0.1, dlom: 0.25 },
};

const INPUTS = {
  params: {},
  inputs: {
    valuation_date: '2026-06-30',
    share_classes: [
      { kind: 'common', name: 'Common', shares: 8_000_000 },
      { kind: 'preferred', name: 'Series A', shares: 4_000_000, preference: 10_000_000, seniority: 1 },
    ],
  },
};

describe.skipIf(!dbUp)('rendering a report costs the same whatever the engagement holds', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    partnerId = await seedPartner(ctx, 'Scaling Partners LLP');
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'], partnerId });
  });
  afterAll(async () => ctx?.teardown());

  /**
   * One engagement for `company`, plus `scale` of everything the render reads:
   * prior valuations of the same client, guideline companies, workbook cells
   * and market research answers. Returns the id of the engagement to render.
   */
  async function seedEngagement(company: string, scale: number): Promise<string> {
    const create = async (): Promise<string> => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(owner.token),
        payload: { kind: '409a', company_name: company },
      });
      expect(res.statusCode).toBe(201);
      return res.json().valuation.id as string;
    };

    const withCalculation = async (id: string, fmv: number, at: Date): Promise<void> => {
      await ctx.pool.query(
        `INSERT INTO calculations
           (id, valuation_id, engine_version, status, inputs, results, equity_value, fmv_per_share, created_at)
         VALUES ($6, $1, '1.4.0', 'succeeded', $2::jsonb, $3::jsonb, 42000000, $4, $5)`,
        [id, JSON.stringify(INPUTS), JSON.stringify(RESULTS), String(fmv), at, newUlid()],
      );
    };

    // The prior valuations behind the FMV trend chart: same firm, same company
    // name, which is exactly `sameCompanyFilter`'s equivalence class.
    for (let i = 0; i < scale; i += 1) {
      const prior = await create();
      await withCalculation(prior, 1 + i * 0.05, new Date(Date.UTC(2020, i % 12, 1)));
    }

    const id = await create();
    await withCalculation(id, 1.2345, new Date(Date.UTC(2026, 5, 30)));

    for (let i = 0; i < scale; i += 1) {
      await ctx.pool.query(
        `INSERT INTO comparable_items (id, valuation_id, ticker, name, included, source, score)
         VALUES ($4, $1, $2, $3, true, 'analyst', 0.8)`,
        [id, `PEER${i}`, `Guideline Company ${i}`, newUlid()],
      );
      await ctx.pool.query(
        `INSERT INTO workbook_cells (valuation_id, sheet, row_key, column_key, value)
         VALUES ($1, 'income_statement', $2, 'fy_current', $3)`,
        [id, `revenue_line_${i}`, 1_000_000 + i],
      );
      await ctx.pool.query(
        `INSERT INTO market_research
           (id, valuation_id, topic, region, question, answer, citations, model, requested_by)
         VALUES ($5, $1, $2, NULL, $3, $4, '[]'::jsonb, 'test', NULL)`,
        [id, `topic_${i}`, `Question ${i}?`, `Answer ${i}.`, newUlid()],
      );
    }

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/draft`,
      headers: authHeader(ops.token),
      payload: {},
    });
    return id;
  }

  async function statementsToRender(id: string): Promise<string[]> {
    const tap = tapQueries(ctx.pool);
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/report.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      return tap.statements;
    } finally {
      tap.restore();
    }
  }

  it('issues no more statements for a large engagement than for a small one', async () => {
    const small = await seedEngagement('Smallco Robotics, Inc.', 2);
    const large = await seedEngagement('Largeco Robotics, Inc.', 8);

    const smallStatements = await statementsToRender(small);
    const largeStatements = await statementsToRender(large);

    // `<=` rather than `===`, as in listQueryScaling: a cached or short-circuited
    // read is a fall, and a fall is never the bug this is looking for.
    expect(
      largeStatements.length,
      `render issued ${largeStatements.length} statements at 4x the data against ` +
        `${smallStatements.length} at 1x:\n${largeStatements.join('\n')}`,
    ).toBeLessThanOrEqual(smallStatements.length);

    // Vacuity guards. A route that stopped reading the database would satisfy
    // the inequality above perfectly, and so would one whose loaders had all
    // been short-circuited by an engagement with nothing in it — so the four
    // tables that were scaled have to appear in the statements that were
    // counted. `summaryFor` is a list of `Promise.all` arguments and a loader
    // dropped out of it is invisible from the count alone.
    expect(smallStatements.length).toBeGreaterThan(8);
    for (const table of ['comparable_items', 'workbook_cells', 'market_research', 'calculations']) {
      expect(
        largeStatements.some((sql) => sql.includes(table)),
        `the render never read ${table}, so scaling it proved nothing`,
      ).toBe(true);
    }
  });

  it('reads the FMV trend through an index rather than scanning the book', async () => {
    /*
     * The one query in `summaryFor` that is not keyed on the valuation being
     * rendered: the trend chart scopes by `(partner_id, lower(trim(company_name)))`
     * across every valuation, so it is the only report query whose cost is a
     * function of the whole table rather than of one engagement.
     *
     * EXPLAIN rather than a timing: at test-fixture volumes Postgres picks a
     * sequential scan whatever the indexes say, and a duration assertion on
     * thirty rows measures the planner's mood. What is asserted is that the
     * plan the planner would use at scale exists — with `enable_seqscan` off,
     * an index path has to be available for both the outer scope and the
     * LATERAL that finds each valuation's latest calculation.
     */
    const client = await ctx.pool.connect();
    try {
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (FORMAT TEXT)
         SELECT c.created_at AS as_of, c.fmv_per_share
           FROM valuations v
           JOIN LATERAL (
             SELECT created_at, fmv_per_share
               FROM calculations
              WHERE valuation_id = v.id
                AND status = 'succeeded'
                AND fmv_per_share IS NOT NULL
                AND created_at <= now()
              ORDER BY created_at DESC
              LIMIT 1
           ) c ON true
          WHERE v.partner_id = $1 AND lower(trim(v.company_name)) = lower(trim($2))
            AND v.kind = ANY($3)
          ORDER BY c.created_at ASC`,
        [partnerId, 'Largeco Robotics, Inc.', ['409a']],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      // The inner side is the half that would be an N+1 in disguise: one
      // sequential scan of `calculations` per valuation in the client's history.
      expect(plan, plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
      expect(plan, plan).not.toMatch(/Seq Scan on calculations/);
    } finally {
      client.release();
    }
  });
});
