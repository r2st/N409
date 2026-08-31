import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, seedUser, authHeader, isDbAvailable, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A page of measurements must not carry the runs behind them (R283).
 *
 * `debt_valuations` stores two jsonb documents per row: `inputs`, the terms the
 * run was made from, and `result`, its whole working. For a bond paying monthly
 * over ten years `result.schedule` is a row per cash flow — tens of kilobytes —
 * and `listValuations` read it with `SELECT *`, fifty rows at a time, for the
 * instrument detail page and for the report's history exhibit.
 *
 * Nothing read them. The instruments page prints `valuation_date` and
 * `fair_value` in its history table and fills its result card only from the run
 * the analyst just made; `historyExhibit` prints the same two columns. Measured
 * on one instrument with 810 stored runs: 910 kB serialised out of Postgres
 * against 7 kB, before node-postgres parses the JSON and Fastify serialises it
 * again on the way out.
 *
 * WHY THIS IS A ROUTE TEST AND NOT A REPO TEST. The claim is about what leaves
 * the service, and the repo's type no longer carries the fields — so a
 * type-level assertion would be tautological, and the thing that could actually
 * regress is a route spreading a full row back into the response. This drives
 * the two endpoints and reads the bytes.
 *
 * The head is asserted too, in the other direction: `loadDebtReport` needs the
 * whole run for the measurement the report speaks for, so the narrowing must
 * not have taken that with it.
 */
describe.skipIf(!dbUp)('an instrument’s measurement history ships summaries, not runs (R283)', () => {
  let ctx: TestApp;
  let token = '';
  let instrumentId = '';

  /** A pricing run with a schedule the size a real bond produces. */
  const runResult = (n: number) => ({
    fair_value: 987654.32,
    ytm: 0.0623,
    schedule: Array.from({ length: 120 }, (_, i) => ({
      period: i + 1,
      date: `2025-${String(1 + (i % 12)).padStart(2, '0')}-01`,
      coupon: 4166.67,
      principal: i === 119 ? 1_000_000 : 0,
      pv: 4166.67 / (1 + 0.0623 / 12) ** (i + 1),
      note: `flow ${i} of run ${n}`,
    })),
  });

  beforeAll(async () => {
    ctx = await setupTestApp();
    token = (await seedUser(ctx, { email: 'ops@test.example.com', roles: ['admin'] })).token;

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: authHeader(token),
      payload: {
        name: 'Ten-year note',
        instrument_type: 'bond',
        params: { face: 1_000_000, coupon_rate: 0.05, frequency: 12, maturity_years: 10 },
      },
    });
    expect(created.statusCode).toBe(201);
    instrumentId = created.json().instrument.id;

    // Written straight to the table: the point is the size of a stored run, and
    // driving the engine twenty times to produce one would make this file a
    // test of the pricer.
    for (let n = 0; n < 20; n++) {
      await ctx.pool.query(
        `INSERT INTO debt_valuations (id, instrument_id, valuation_date, inputs, result, fair_value)
         VALUES ('Q' || upper(lpad(to_hex($1::int), 25, '0')), $2, $3, $4, $5, $6)`,
        [
          n + 1,
          instrumentId,
          `2025-${String(1 + (n % 12)).padStart(2, '0')}-15`,
          JSON.stringify({ face: 1_000_000, coupon_rate: 0.05, run: n }),
          JSON.stringify(runResult(n)),
          900_000 + n,
        ],
      );
    }
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  it('seeds runs big enough that carrying them would show', async () => {
    // Vacuity guard: every assertion below passes over an empty history, and
    // over one whose rows are small enough that the two shapes are the same
    // response.
    const { rows } = await ctx.pool.query<{ n: string; bytes: string }>(
      `SELECT count(*)::text AS n, sum(octet_length(result::text))::text AS bytes
         FROM debt_valuations WHERE instrument_id = $1`,
      [instrumentId],
    );
    expect(Number(rows[0]!.n)).toBe(20);
    expect(Number(rows[0]!.bytes)).toBeGreaterThan(100_000);
  });

  for (const [what, url] of [
    ['the detail page', (id: string) => `/api/v1/debt/instruments/${id}`],
    ['the history endpoint', (id: string) => `/api/v1/debt/instruments/${id}/valuations`],
  ] as const) {
    it(`${what} answers with dates and fair values and nothing else`, async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: url(instrumentId),
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json().valuations as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(20);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([
          'created_at',
          'created_by',
          'fair_value',
          'id',
          'instrument_id',
          'valuation_date',
        ]);
      }
      // The measurable claim, rather than only the shape one: the response is
      // the size of a table, not of twenty pricing runs. The runs alone are
      // >100 kB (asserted above); 40 kB leaves the whole rest of the payload —
      // instrument, params, credit terms — room to grow without this becoming a
      // test of how wide an instrument row is.
      expect(res.body.length).toBeLessThan(40_000);
      expect(res.body).not.toContain('schedule');
    });
  }

  it('still dates the history by measurement date, newest first', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/debt/instruments/${instrumentId}/valuations`,
      headers: authHeader(token),
    });
    const dates = (res.json().valuations as Array<{ valuation_date: string }>).map((v) => v.valuation_date);
    expect(dates).toEqual([...dates].sort().reverse());
    // A `date` column normalised to its day, not the instant the driver made of
    // it — the narrow projection has to keep going through `calendarDateRow`.
    for (const d of dates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the report still reads the head run in full', async () => {
    const { loadDebtReport } = await import('../../src/repos/measurementReport.js');
    const { rows } = await ctx.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id)
       SELECT 'V' || upper(lpad(to_hex(9), 25, '0')), 'debt', 'Issuer', id FROM users LIMIT 1
       RETURNING *`,
    );
    const valuation = rows[0]!;
    await ctx.pool.query('UPDATE debt_instruments SET valuation_id = $1 WHERE id = $2', [
      valuation.id,
      instrumentId,
    ]);

    const data = await loadDebtReport(ctx.pool, valuation);
    expect(data).not.toBeNull();
    // The head carries its working…
    expect(data!.valuation).not.toBeNull();
    expect((data!.valuation!.result as { schedule?: unknown[] }).schedule).toHaveLength(120);
    expect(data!.valuation!.inputs).toBeTruthy();
    // …and it is the same row the screen's history table heads with, which is
    // what reading it by id rather than re-asking for "the newest" guarantees.
    expect(data!.valuation!.id).toBe(data!.history[0]!.id);
    // …while the tail behind it does not.
    expect(data!.history).toHaveLength(20);
    for (const row of data!.history) expect(row).not.toHaveProperty('result');
  });
});
