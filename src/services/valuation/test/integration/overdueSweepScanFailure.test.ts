import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The overdue sweep's *scan* failing, rather than one of its rows.
 *
 * `overdueSweepRowFailure` closed the row half: anything that threw while the
 * loop was chasing an engagement took the whole run down, and the 500 carried
 * no `reminded`, so the operator's obvious next move — press it again — mailed
 * every analyst already chased a second time. The per-row catch fixed that for
 * everything the loop does *to* a row.
 *
 * It did not cover the reads that produce the rows. `eachActiveEngagement` is a
 * generator issuing one keyset query per page from inside the `for await`, so a
 * statement timeout on a later page, or a pool checkout that waits out its
 * ceiling between pages, throws past every catch in the body and out of the
 * handler — the identical harm, returning by the one door the per-row catch
 * does not stand in.
 *
 * R292 sharpened it. The endpoint now takes an advisory lock, and a pass that
 * throws releases it on the way out; so nothing at all stands between the 500
 * and the second press that mails everybody twice.
 *
 * Driven by failing the page read itself, which is what a statement timeout on
 * the roster looks like from here.
 */
describe.skipIf(!dbUp)('the overdue sweep scan failing part-way through the book', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let overdueId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Scan Failure Co' },
    });
    overdueId = created.json().valuation.id as string;
    const assigned = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${overdueId}/engagement/assign`,
      headers: authHeader(ops.token),
      payload: { analyst_id: analyst.id },
    });
    expect(assigned.statusCode).toBe(200);
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '400 days' WHERE valuation_id = $1`,
      [overdueId],
    );
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const sweep = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });

  /** The keyset page read in `eachActiveEngagement`, and nothing else. */
  const isPageRead = (sql: string) => sql.includes('ORDER BY e.id ASC') && sql.includes('LEFT JOIN LATERAL');

  it('answers with what it reached instead of a 500 that discards it', async () => {
    const restore = interceptPoolQueries(pool, (sql, phase) => {
      if (phase === 'before' && isPageRead(sql)) {
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      }
      return undefined;
    });
    let body: Record<string, unknown>;
    try {
      const res = await sweep();
      // Not a 500. The counts are the thing an operator has to read before
      // deciding whether to press the button again, and a 500 is the one answer
      // that throws them away.
      expect(res.statusCode).toBe(200);
      body = res.json();
    } finally {
      restore();
    }

    // And it says so, rather than reporting the empty run as a clean one.
    // `scanned: 0` and `reminded_count: 0` are exactly what a settled book with
    // nothing overdue looks like; without these two fields the two are the same
    // response.
    expect(body.incomplete).toBe(true);
    // The classified token `logUnretried` wrote beside the error, not the
    // driver's sentence — the same vocabulary `failed` and `unrecorded` report.
    expect(body.incomplete_reason).toBe('pg.57014');
    expect(body.reminded).toEqual([]);
    expect(body.scanned).toBe(0);

    // Nothing was mailed and nothing was written down, so the re-run below is
    // the first time this analyst hears about it.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM email_outbox WHERE template_key = 'engagement_overdue'`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('reports a run that walked the whole book as complete', async () => {
    // The other side of the pair: `incomplete` must be the interleaving and not
    // a flag this sweep raises whenever it feels like it. Also the re-press the
    // failure above invites — it is meant to be safe, and it is only safe
    // because the failed pass sent nothing.
    const res = await sweep();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incomplete).toBe(false);
    expect(body.incomplete_reason).toBeNull();
    expect(body.reminded).toContain(overdueId);
  });
});
