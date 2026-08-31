import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Which engagement is told the measurement subject left.
 *
 * `PUT /funds/:id/valuation` is a read-then-write pair: it writes
 * `measurement_subject_unlinked` to the engagement the portfolio *was* on, and
 * then overwrites the link. Both halves ran on the pool, two statements with a
 * gap, so a second link change landing in the gap made the first half describe
 * a state that no longer existed. The detach was announced to the engagement
 * the portfolio used to be on; the one it was actually taken off was never
 * told. That trail then says the portfolio is its measurement subject with
 * nothing afterwards saying it stopped — and it is what an auditor reads to
 * find out why the NAV schedule `domain/navExhibits.ts` renders from that link
 * is missing from the next render.
 *
 * Driven by holding the portfolio's row from a second connection, so the
 * request has to arrive at the pair and wait rather than be raced into it. The
 * competing change is then made and committed while the request is stopped, and
 * the request continues. Both halves of the pair are on the far side of the
 * wait, so the interleaving is what happens rather than what the test hopes
 * for.
 */
describe.skipIf(!dbUp)('a link change landing inside another one', () => {
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

  const engagement = async (name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: 'fund', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const fundLinkedTo = async (name: string, valuationId: string): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name, fund_type: 'vc', currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().fund.id as string;
    const linked = await app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${id}/valuation`,
      headers: authHeader(ops.token),
      payload: { valuation_id: valuationId },
    });
    expect(linked.statusCode).toBe(200);
    return id;
  };

  const unlinkEvents = async (valuationId: string): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM valuation_events
        WHERE valuation_id = $1 AND type = 'measurement_subject_unlinked'`,
      [valuationId],
    );
    return rows[0]!.n;
  };

  /**
   * Wait until some backend is blocked on a lock — the request having reached
   * the row we are holding. Polled rather than slept: a fixed delay is either
   * flaky or slow, and this is the condition the test actually depends on.
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
      if (Date.now() >= deadline) throw new Error('no backend ever blocked on the portfolio row');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it('tells the engagement the portfolio was actually taken off', async () => {
    const a = await engagement('Link Race A');
    const b = await engagement('Link Race B');
    const fundId = await fundLinkedTo('Link Race Fund', a);
    const unlinksOnABefore = await unlinkEvents(a);

    const holder = await pool.connect();
    let inFlight: ReturnType<typeof app.inject> | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT * FROM fund_portfolios WHERE id = $1 FOR UPDATE', [fundId]);

      // The detach. It reaches the read-then-write pair and stops on the row.
      inFlight = app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${fundId}/valuation`,
        headers: authHeader(ops.token),
        payload: { valuation_id: null },
      });
      await waitForABlockedBackend();

      // The competing move, committed while the request is stopped: the
      // portfolio is re-pointed from A to B.
      await holder.query('UPDATE fund_portfolios SET valuation_id = $2 WHERE id = $1', [fundId, b]);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    const detached = await inFlight!;
    expect(detached.statusCode).toBe(200);
    expect(detached.json().fund.valuation_id).toBeNull();

    // B held the portfolio at the moment it was detached, so B is the trail
    // that has to record it. This is the assertion a read on the pool failed.
    expect(await unlinkEvents(b)).toBe(1);
    // And A, which had already lost it, is not told a second time about a
    // detach it was not party to.
    expect(await unlinkEvents(a)).toBe(unlinksOnABefore);
  });

  it('still records an ordinary detach against the engagement holding it', async () => {
    // The control: same route, no interleaving. A handler that had simply
    // stopped writing the event would pass the pair above and fail here.
    const c = await engagement('Link Race C');
    const fundId = await fundLinkedTo('Quiet Fund', c);
    const detached = await app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/valuation`,
      headers: authHeader(ops.token),
      payload: { valuation_id: null },
    });
    expect(detached.statusCode).toBe(200);
    expect(await unlinkEvents(c)).toBe(1);
  });
});
