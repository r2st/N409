import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { retireValuations } from '../../src/repos/valuationPurge.js';

const dbUp = await isDbAvailable();

/**
 * An engagement withdrawn between the link check and the link.
 *
 * `PUT /funds/:id/valuation` refuses to attach a measurement subject to
 * withdrawn work — "attaching a measurement subject to withdrawn work gives a
 * retired engagement a NAV schedule it did not have" — and asks that question
 * on the pool, then opens a transaction and writes. R284 closed exactly this
 * gap on the mark route and left it open here.
 *
 * What lands in it is not a small thing. The link is the whole data source
 * `domain/navExhibits.ts` renders the NAV schedule from, so the withdrawn
 * engagement acquires a schedule; the attach writes
 * `measurement_subject_linked` onto a spine whose 0001 trigger refuses every
 * UPDATE and DELETE afterwards; and retirement is reversible (R90), so it all
 * comes back with the engagement. The route answered 200 for it.
 *
 * Driven with the same instrument the fix uses against it: the portfolio's row
 * is held `FOR UPDATE` from a second connection, so the request has to arrive
 * at the transaction and wait. The retirement is committed on the far side of
 * that wait, which makes the interleaving the thing that happens rather than
 * the thing the test hopes for.
 */
describe.skipIf(!dbUp)('an engagement retired between the link check and the link', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const engagement = async (kind: 'fund' | 'debt', name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind, company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const fund = async (name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name, fund_type: 'vc', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().fund.id as string;
  };

  const instrument = async (name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: authHeader(ops.token),
      payload: { name, instrument_type: 'bond', currency: 'USD', params: {} },
    });
    expect(res.statusCode).toBe(201);
    return res.json().instrument.id as string;
  };

  /**
   * Wait until some backend is blocked on a lock — the request having reached
   * the row we are holding. Polled rather than slept, as in
   * `measurementLinkRace`: a fixed delay is either flaky or slow.
   */
  const waitForABlockedBackend = async (): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()`,
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      if (Date.now() >= deadline) throw new Error('no backend ever blocked on the subject row');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const linkEvents = async (valuationId: string): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM valuation_events
        WHERE valuation_id = $1 AND type = 'measurement_subject_linked'`,
      [valuationId],
    );
    return rows[0]!.n;
  };

  /**
   * Send the link request while `table`.`subjectId` is held from a second
   * connection, retire the engagement inside that wait, then let it go.
   */
  const linkWhileRetiring = async (url: string, valuationId: string, hold: string, subjectId: string) => {
    const holder = await pool.connect();
    let inFlight: ReturnType<typeof app.inject> | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM ${hold} WHERE id = $1 FOR UPDATE`, [subjectId]);
      inFlight = app.inject({
        method: 'PUT',
        url,
        headers: authHeader(ops.token),
        payload: { valuation_id: valuationId },
      });
      await waitForABlockedBackend();
      const { retired } = await retireValuations(pool, [valuationId]);
      expect(retired).toEqual([valuationId]);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    return inFlight!;
  };

  it('refuses a fund link whose engagement was withdrawn while it waited', async () => {
    const valuationId = await engagement('fund', 'Link Retire Fund');
    const fundId = await fund('Link Retire Portfolio');

    const res = await linkWhileRetiring(
      `/api/v1/funds/${fundId}/valuation`,
      valuationId,
      'fund_portfolios',
      fundId,
    );

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/retired/i);
    // And nothing landed. A 409 over a committed link would be the worse half:
    // the withdrawn engagement would already have a NAV schedule.
    const { rows } = await pool.query<{ valuation_id: string | null }>(
      'SELECT valuation_id FROM fund_portfolios WHERE id = $1',
      [fundId],
    );
    expect(rows[0]!.valuation_id).toBeNull();
    expect(await linkEvents(valuationId)).toBe(0);
  });

  it('refuses a debt link whose engagement was withdrawn while it waited', async () => {
    const valuationId = await engagement('debt', 'Link Retire Debt');
    const instrumentId = await instrument('Link Retire Bond');

    const res = await linkWhileRetiring(
      `/api/v1/debt/instruments/${instrumentId}/valuation`,
      valuationId,
      'debt_instruments',
      instrumentId,
    );

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/retired/i);
    const { rows } = await pool.query<{ valuation_id: string | null }>(
      'SELECT valuation_id FROM debt_instruments WHERE id = $1',
      [instrumentId],
    );
    expect(rows[0]!.valuation_id).toBeNull();
    expect(await linkEvents(valuationId)).toBe(0);
  });

  it('still links when the engagement is live throughout', async () => {
    // The control the two refusals need: same route, same held row, no
    // retirement — so the 409s came from the state of the file and not from a
    // link route that had stopped working under a lock.
    const valuationId = await engagement('fund', 'Link Live Fund');
    const fundId = await fund('Link Live Portfolio');

    const holder = await pool.connect();
    let inFlight: ReturnType<typeof app.inject> | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM fund_portfolios WHERE id = $1 FOR UPDATE', [fundId]);
      inFlight = app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${fundId}/valuation`,
        headers: authHeader(ops.token),
        payload: { valuation_id: valuationId },
      });
      await waitForABlockedBackend();
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    const res = await inFlight!;
    expect(res.statusCode).toBe(200);
    expect(res.json().fund.valuation_id).toBe(valuationId);
    expect(await linkEvents(valuationId)).toBe(1);
  });
});
